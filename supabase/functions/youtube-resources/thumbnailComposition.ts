import { mediaSendability } from "../_shared/partnerMediaStore.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import type { YouTubeResourceErrorCode, YouTubeSetThumbnailResult } from "./contracts.ts";
import type {
  YouTubeResourceAccount,
  YouTubeThumbnailPort,
  YouTubeTokenResult,
} from "./handler.ts";
import {
  isAdmissibleThumbnailStorageLocation,
  isDirectThumbnailMime,
  THUMBNAIL_MAX_BYTES,
  verifyDirectThumbnailBytes,
} from "./thumbnailMedia.ts";
import { YOUTUBE_THUMBNAIL_SET_UNIT_COST, type WriteBudgetDebitResult, type WriteCounterResult } from "./writeLimits.ts";
import type { YouTubeReadClient } from "./youtubeReadClient.ts";

const THUMBNAIL_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const THUMBNAIL_UPLOAD_TIMEOUT_MS = 30_000;

export interface OwnedThumbnailMediaRow {
  id: string;
  userId: string;
  filePath: string;
  fileType: string;
  fileSize: number | null;
  mimeType: string | null;
  storageBucket: string | null;
  scanState?: string | null;
}

export type OwnedThumbnailMediaLookup =
  | { ok: true; row: OwnedThumbnailMediaRow | null }
  | { ok: false; reason: "read_error" };

export type ThumbnailDownloadResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; reason: "too_large" | "not_usable" | "storage_error" };

export interface YouTubeThumbnailCompositionDeps {
  media: {
    loadOwned(input: { mediaFileId: string; userId: string }): Promise<OwnedThumbnailMediaLookup>;
    downloadBytes(row: OwnedThumbnailMediaRow): Promise<ThumbnailDownloadResult>;
  };
  writeLimits: {
    checkUserWriteCounters(userId: string): Promise<WriteCounterResult>;
    debitWriteBudget(units: number): Promise<WriteBudgetDebitResult>;
  };
  stillBound(input: {
    accountId: string;
    ownerId: string;
    channelId: string;
    accessToken: string;
  }): Promise<boolean>;
  tokens: {
    get(account: YouTubeResourceAccount, options: { force: boolean }): Promise<YouTubeTokenResult>;
  };
  youtube: Pick<YouTubeReadClient, "getVideo">;
  fetchImpl: typeof fetch;
  uploadTimeoutMs?: number;
}

function classifyUploadStatus(status: number): YouTubeResourceErrorCode {
  if (status === 403) return "thumbnail_not_allowed";
  if (status === 401) return "reconnect_required";
  if (status === 404) return "not_found";
  if (status === 429) return "quota_exceeded";
  if (status >= 500) return "outcome_unknown";
  return "upstream_unavailable";
}

function isUsableMediaRow(row: OwnedThumbnailMediaRow | null, userId: string): row is OwnedThumbnailMediaRow {
  if (!row || row.userId !== userId) return false;
  if (row.fileType !== "image") return false;
  if (!isDirectThumbnailMime(row.mimeType)) return false;
  if (row.fileSize !== null && (row.fileSize <= 0 || row.fileSize > THUMBNAIL_MAX_BYTES)) return false;
  if (!isAdmissibleThumbnailStorageLocation(row.storageBucket, row.filePath, userId)) return false;
  const sendability = mediaSendability({ scanState: row.scanState ?? "available" });
  return sendability.ok;
}

/**
 * Implements the 8-step Spec §8.2 server sequence for replacing a published
 * YouTube video's thumbnail.
 */
export function createYouTubeThumbnailPort(
  deps: YouTubeThumbnailCompositionDeps,
): YouTubeThumbnailPort {
  const uploadTimeoutMs = deps.uploadTimeoutMs ?? THUMBNAIL_UPLOAD_TIMEOUT_MS;

  return {
    async setThumbnail({ account, userId, videoId, mediaFileId }): Promise<
      | { ok: true; value: YouTubeSetThumbnailResult }
      | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
    > {
      // Step 1: Capability and channel binding check.
      const caps = deriveYouTubeCapabilities({
        id: account.id,
        channelId: account.channelId,
        channelTitle: account.channelTitle,
        authProvider: account.authProvider,
        needsReauth: account.needsReauth,
        hasAccessToken: Boolean(account.accessToken),
        hasRefreshToken: Boolean(account.refreshToken),
        accountMetadata: account.accountMetadata,
      });
      const manageThumbnail = caps.capabilities.manage_thumbnail;
      if (manageThumbnail?.state === "unavailable") {
        return { ok: false, code: manageThumbnail.reason };
      }
      if (account.channelId === null) {
        return { ok: false, code: "reconnect_required" };
      }
      const channelId = account.channelId;

      // Step 2: Load owned media row by id and user_id.
      const lookup = await deps.media.loadOwned({ mediaFileId, userId });
      if (!lookup.ok) {
        return { ok: false, code: "internal_error" };
      }
      if (!isUsableMediaRow(lookup.row, userId)) {
        return { ok: false, code: "media_not_usable" };
      }
      const mediaRow = lookup.row;

      // Step 3: Per-user write counters (burst + daily).
      const counterResult = await deps.writeLimits.checkUserWriteCounters(userId);
      if (!counterResult.ok) {
        return {
          ok: false,
          code: counterResult.code,
          ...(counterResult.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: counterResult.retryAfterSeconds }
            : {}),
        };
      }

      // Step 4: Obtain token and verify video ownership via getVideo (1 unit).
      const initialToken = await deps.tokens.get(account, { force: false });
      if (!initialToken.ok) {
        return { ok: false, code: initialToken.code };
      }
      let accessToken = initialToken.accessToken;
      let video = await deps.youtube.getVideo(accessToken, { channelId, videoId });
      if (!video.ok && video.unauthorized && !initialToken.minted) {
        const refreshed = await deps.tokens.get(account, { force: true });
        if (!refreshed.ok) {
          return { ok: false, code: refreshed.code };
        }
        accessToken = refreshed.accessToken;
        video = await deps.youtube.getVideo(accessToken, { channelId, videoId });
      }
      if (!video.ok) {
        return { ok: false, code: video.code };
      }

      // Step 5: Download bytes from Postora's own storage and verify magic bytes.
      const downloaded = await deps.media.downloadBytes(mediaRow);
      if (!downloaded.ok) {
        return {
          ok: false,
          code: downloaded.reason === "storage_error" ? "upstream_unavailable" : "media_not_usable",
        };
      }
      const verified = verifyDirectThumbnailBytes(downloaded.bytes, mediaRow.mimeType);
      if (!verified.ok) {
        return { ok: false, code: "media_not_usable" };
      }

      // Step 6: Debit shared project write budget (50 units) last, then verify stillBound.
      const budget = await deps.writeLimits.debitWriteBudget(YOUTUBE_THUMBNAIL_SET_UNIT_COST);
      if (!budget.ok) {
        return {
          ok: false,
          code: budget.code,
          ...(budget.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: budget.retryAfterSeconds }
            : {}),
        };
      }
      const bound = await deps.stillBound({
        accountId: account.id,
        ownerId: userId,
        channelId,
        accessToken,
      });
      if (!bound) {
        return { ok: false, code: "reconnect_required" };
      }

      // Step 7 & 8: Single upload attempt to Google's thumbnails.set, never retried.
      const url = `${THUMBNAIL_UPLOAD_ENDPOINT}?videoId=${encodeURIComponent(videoId)}`;
      try {
        const response = await deps.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${accessToken}`,
            "Content-Type": verified.mimeType,
          },
          body: downloaded.bytes as BodyInit,
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
        if (response.ok) {
          return { ok: true, value: { video_id: videoId, applied: true } };
        }
        return { ok: false, code: classifyUploadStatus(response.status) };
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }
    },
  };
}
