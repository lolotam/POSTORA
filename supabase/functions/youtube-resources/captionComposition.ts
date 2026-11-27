import { classifyGoogleError } from "../_shared/youtubeApiErrors.ts";
import { deriveYouTubeCapabilities } from "./capabilities.ts";
import { type CaptionFormat, validateCaptionUploadInput } from "./captionFile.ts";
import type {
  YouTubeCaptionTrack,
  YouTubeCaptionsListData,
  YouTubeResourceErrorCode,
  YouTubeUploadCaptionData,
} from "./contracts.ts";
import type {
  YouTubeCaptionPort,
  YouTubeResourceAccount,
  YouTubeTokenResult,
} from "./handler.ts";
import {
  YOUTUBE_CAPTION_LIST_UNIT_COST,
  YOUTUBE_CAPTION_UPLOAD_UNIT_COST,
  type WriteBudgetDebitResult,
  type WriteCounterResult,
} from "./writeLimits.ts";
import type { YouTubeReadClient } from "./youtubeReadClient.ts";

const CAPTIONS_LIST_ENDPOINT = "https://www.googleapis.com/youtube/v3/captions";
const CAPTIONS_UPLOAD_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/captions";
const CAPTIONS_LIST_TIMEOUT_MS = 15_000;
const CAPTIONS_UPLOAD_TIMEOUT_MS = 60_000;

export interface YouTubeCaptionCompositionDeps {
  writeLimits: {
    checkCaptionListCounter(userId: string): Promise<WriteCounterResult>;
    checkCaptionUploadCounter(userId: string): Promise<WriteCounterResult>;
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
  listTimeoutMs?: number;
  uploadTimeoutMs?: number;
}

function checkCaptionCapability(
  account: YouTubeResourceAccount,
): { ok: true; channelId: string } | { ok: false; code: YouTubeResourceErrorCode } {
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
  const manageCaptions = caps.capabilities.manage_captions;
  if (manageCaptions?.state === "unavailable") {
    return { ok: false, code: manageCaptions.reason };
  }
  if (account.channelId === null) {
    return { ok: false, code: "reconnect_required" };
  }
  return { ok: true, channelId: account.channelId };
}

async function verifyVideoOwnership(
  deps: Pick<YouTubeCaptionCompositionDeps, "tokens" | "youtube">,
  account: YouTubeResourceAccount,
  channelId: string,
  videoId: string,
): Promise<{ ok: true; accessToken: string } | { ok: false; code: YouTubeResourceErrorCode }> {
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
  return { ok: true, accessToken };
}

function parseCaptionTrack(raw: unknown): YouTubeCaptionTrack | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== "string" || item.id.length === 0) return null;
  if (!item.snippet || typeof item.snippet !== "object" || Array.isArray(item.snippet)) return null;
  const snippet = item.snippet as Record<string, unknown>;
  if (typeof snippet.language !== "string" || snippet.language.length === 0) return null;
  return {
    id: item.id,
    language: snippet.language,
    name: typeof snippet.name === "string" ? snippet.name : "",
    track_kind: typeof snippet.trackKind === "string" ? snippet.trackKind : null,
    is_draft: typeof snippet.isDraft === "boolean" ? snippet.isDraft : null,
    status: typeof snippet.status === "string" ? snippet.status : null,
    last_updated: typeof snippet.lastUpdated === "string" ? snippet.lastUpdated : null,
  };
}

function parseCaptionsListBody(body: unknown): YouTubeCaptionTrack[] | null {
  if (!body || typeof body !== "object" || Array.isArray(body)) return null;
  const record = body as Record<string, unknown>;
  if (!Array.isArray(record.items)) return null;
  const tracks: YouTubeCaptionTrack[] = [];
  for (const item of record.items) {
    const parsed = parseCaptionTrack(item);
    if (!parsed) return null;
    tracks.push(parsed);
  }
  return tracks;
}

async function readErrorJson(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

function classifyCaptionListFailure(status: number, body: unknown): YouTubeResourceErrorCode {
  const errClass = classifyGoogleError(status, body);
  if (errClass === "unauthorized") return "reconnect_required";
  if (errClass === "quota") return "quota_exceeded";
  if (errClass === "scope_missing") return "missing_scope";
  if (errClass === "not_found" || errClass === "forbidden") return "not_found";
  return "upstream_unavailable";
}

function classifyCaptionUploadFailure(status: number, body: unknown): YouTubeResourceErrorCode {
  if (status === 409) return "caption_conflict";
  if (status === 400) return "caption_invalid";
  if (status === 401) return "reconnect_required";
  if (status === 404) return "not_found";
  if (status === 429) return "quota_exceeded";
  if (status === 403) {
    const errClass = classifyGoogleError(status, body);
    if (errClass === "quota") return "quota_exceeded";
    if (errClass === "scope_missing") return "missing_scope";
    return "not_found";
  }
  if (status >= 500) return "outcome_unknown";
  return "upstream_unavailable";
}

function buildMultipartRelatedBody(input: {
  boundary: string;
  videoId: string;
  language: string;
  name: string;
  format: CaptionFormat;
  content: string;
}): string {
  const metadataJson = JSON.stringify({
    snippet: {
      videoId: input.videoId,
      language: input.language,
      name: input.name,
      isDraft: false,
    },
  });
  const mediaContentType = input.format === "vtt" ? "text/vtt" : "application/x-subrip";
  return [
    `--${input.boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    metadataJson,
    `--${input.boundary}`,
    `Content-Type: ${mediaContentType}; charset=UTF-8`,
    "",
    input.content,
    `--${input.boundary}--`,
    "",
  ].join("\r\n");
}

/**
 * Implements Spec §11.1 caption listing and single-attempt multipart caption upload
 * behind `YouTubeCaptionPort`.
 */
export function createYouTubeCaptionPort(
  deps: YouTubeCaptionCompositionDeps,
): YouTubeCaptionPort {
  const listTimeoutMs = deps.listTimeoutMs ?? CAPTIONS_LIST_TIMEOUT_MS;
  const uploadTimeoutMs = deps.uploadTimeoutMs ?? CAPTIONS_UPLOAD_TIMEOUT_MS;

  return {
    async listCaptions({ account, userId, videoId }): Promise<
      | { ok: true; value: YouTubeCaptionsListData }
      | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
    > {
      const cap = checkCaptionCapability(account);
      if (!cap.ok) return cap;

      const counter = await deps.writeLimits.checkCaptionListCounter(userId);
      if (!counter.ok) {
        return {
          ok: false,
          code: counter.code,
          ...(counter.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: counter.retryAfterSeconds }
            : {}),
        };
      }

      const ownership = await verifyVideoOwnership(deps, account, cap.channelId, videoId);
      if (!ownership.ok) return ownership;

      const budget = await deps.writeLimits.debitWriteBudget(YOUTUBE_CAPTION_LIST_UNIT_COST);
      if (!budget.ok) {
        return {
          ok: false,
          code: budget.code,
          ...(budget.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: budget.retryAfterSeconds }
            : {}),
        };
      }

      const url = `${CAPTIONS_LIST_ENDPOINT}?part=snippet&videoId=${encodeURIComponent(videoId)}`;
      try {
        const response = await deps.fetchImpl(url, {
          method: "GET",
          headers: { Authorization: `Bearer ${ownership.accessToken}` },
          signal: AbortSignal.timeout(listTimeoutMs),
        });
        if (!response.ok) {
          const errorBody = await readErrorJson(response);
          return { ok: false, code: classifyCaptionListFailure(response.status, errorBody) };
        }
        let payload: unknown;
        try {
          payload = await response.json();
        } catch {
          return { ok: false, code: "upstream_unavailable" };
        }
        const items = parseCaptionsListBody(payload);
        if (!items) {
          return { ok: false, code: "upstream_unavailable" };
        }
        return { ok: true, value: { video_id: videoId, items } };
      } catch {
        return { ok: false, code: "upstream_unavailable" };
      }
    },

    async uploadCaption({ account, userId, videoId, language, name, format, content }): Promise<
      | { ok: true; value: YouTubeUploadCaptionData }
      | { ok: false; code: YouTubeResourceErrorCode; retryAfterSeconds?: number }
    > {
      const cap = checkCaptionCapability(account);
      if (!cap.ok) return cap;

      const validated = validateCaptionUploadInput({ language, name, format, content });
      if (!validated.ok) {
        return { ok: false, code: "caption_invalid" };
      }

      const counter = await deps.writeLimits.checkCaptionUploadCounter(userId);
      if (!counter.ok) {
        return {
          ok: false,
          code: counter.code,
          ...(counter.retryAfterSeconds !== undefined
            ? { retryAfterSeconds: counter.retryAfterSeconds }
            : {}),
        };
      }

      const ownership = await verifyVideoOwnership(deps, account, cap.channelId, videoId);
      if (!ownership.ok) return ownership;

      const budget = await deps.writeLimits.debitWriteBudget(YOUTUBE_CAPTION_UPLOAD_UNIT_COST);
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
        channelId: cap.channelId,
        accessToken: ownership.accessToken,
      });
      if (!bound) {
        return { ok: false, code: "reconnect_required" };
      }

      const boundary = `postora-caption-${crypto.randomUUID()}`;
      const body = buildMultipartRelatedBody({
        boundary,
        videoId,
        language,
        name,
        format,
        content,
      });
      const url = `${CAPTIONS_UPLOAD_ENDPOINT}?part=snippet&uploadType=multipart`;
      try {
        const response = await deps.fetchImpl(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${ownership.accessToken}`,
            "Content-Type": `multipart/related; boundary=${boundary}`,
          },
          body,
          signal: AbortSignal.timeout(uploadTimeoutMs),
        });
        if (response.ok) {
          let payload: unknown;
          try {
            payload = await response.json();
          } catch {
            return { ok: false, code: "outcome_unknown" };
          }
          const track = parseCaptionTrack(payload);
          if (!track) {
            return { ok: false, code: "outcome_unknown" };
          }
          return { ok: true, value: { video_id: videoId, track } };
        }
        const errorBody = await readErrorJson(response);
        return { ok: false, code: classifyCaptionUploadFailure(response.status, errorBody) };
      } catch {
        return { ok: false, code: "outcome_unknown" };
      }
    },
  };
}
