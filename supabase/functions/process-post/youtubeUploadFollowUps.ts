/**
 * The things that happen AFTER the video exists: the thumbnail, the first
 * comment, the playlist insert, and the caption track upload.
 *
 * They belong to the run that CREATED the video. Two runs can reach a video:
 * the one that uploaded it, and the one that inherited its receipt after an
 * interruption. Only the first one does the follow-ups, because a first
 * comment posted twice is a duplicate on the customer's channel.
 *
 * No follow-up is allowed to fail the publish. The video is already
 * live, and the public row has to be settled either way, so a failure is
 * logged and the publish carries on.
 *
 * All follow-ups are best-effort requests, so all are bounded by what is
 * left of the worker: a follow-up that runs out of time is skipped, and the
 * video is still recorded. A follow-up that never ends would take the worker
 * with it, and the outcome would never be written at all.
 */

import { validateCaptionUploadInput } from "../_shared/captionFile.ts";
import { redactProviderText } from "./youtubeUploadPolicy.ts";

export interface YoutubeCaptionFollowUpInput {
  language: string;
  name: string;
  format: "srt" | "vtt";
  content: string;
}

/** What the follow-ups need to know about the video. */
export interface YoutubeFollowUpRequest {
  videoId: string;
  /** The bound channel that owns the video; required by commentThreads.insert. */
  channelId: string;
  accessToken: string;
  /** The thumbnail the customer asked for, if any. */
  thumbnailUrl: string | null;
  /** The first comment the customer asked for, if any. */
  firstComment: string | null;
  /** The playlist the customer asked to add the video to, if any. */
  playlistId?: string | null;
  /** The caption track the customer asked to attach after upload, if any. */
  caption?: YoutubeCaptionFollowUpInput | null;
}

/** The bytes of a file the follow-ups send. */
export interface YoutubeFollowUpFile {
  blob: Blob;
  mimeType: string;
}

/**
 * What the follow-ups need from the outside world.
 *
 * The download is a port because it is the read of the MEDIA HOST, and the
 * host policy belongs to the caller: a follow-up may only read a host the
 * customer was approved for.
 */
export interface YoutubeFollowUpDeps {
  /** The provider calls. */
  fetchImpl: typeof fetch;
  canWrite(): Promise<boolean>;
  /**
   * The thumbnail bytes.
   *
   * The timeout bounds the WHOLE read: the headers AND the body.
   */
  downloadThumbnail(url: string, timeoutMs: number): Promise<YoutubeFollowUpFile>;
  /**
   * The time one follow-up may take.
   *
   * Zero means there is no time for it, so it is skipped.
   */
  budgetMs(): number;
  /** Debits the project-wide write budget before a playlist or caption insert. */
  debitWriteBudget?: (units?: number) => Promise<boolean>;
  /**
   * Whether the account's granted_scopes explicitly includes
   * `https://www.googleapis.com/auth/youtube.force-ssl` (`D-P7-4`).
   */
  hasCaptionScope?: () => boolean;
  /**
   * Checks the per-user daily caption upload allowance
   * (`youtube-resources:caption-upload:day`, 2 per 24 h).
   */
  checkCaptionUploadAllowance?: () => Promise<boolean>;
}

const THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const COMMENT_ENDPOINT = "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet";
const PLAYLISTS_PRECHECK_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlists";
const PLAYLIST_ITEMS_ENDPOINT = "https://www.googleapis.com/youtube/v3/playlistItems?part=snippet";
const CAPTIONS_UPLOAD_ENDPOINT =
  "https://www.googleapis.com/upload/youtube/v3/captions?part=snippet&uploadType=multipart";
const PLAYLIST_ID_PATTERN = /^[A-Za-z0-9_-]{10,64}$/;
const PLAYLIST_INSERT_UNIT_COST = 50;
const CAPTION_INSERT_UNIT_COST = 400;
const CAPTION_MAX_TIMEOUT_MS = 60_000;

export interface YoutubeFollowUpOutcome {
  state: "not_requested" | "applied" | "skipped" | "failed" | "unknown";
  reason: string | null;
}

export interface YoutubeFollowUpResults {
  thumbnail: YoutubeFollowUpOutcome;
  first_comment: YoutubeFollowUpOutcome;
  playlist: YoutubeFollowUpOutcome;
  caption: YoutubeFollowUpOutcome;
}

const NOT_REQUESTED: YoutubeFollowUpOutcome = { state: "not_requested", reason: null };

/**
 * The follow-ups of one video.
 *
 * Each follow-up asks for the time that is left for itself, so the next one
 * is skipped rather than started when the worker has already run out of time.
 * The observed outcome is returned so the settlement can record what actually
 * happened instead of guessing from the request.
 */
export async function runYoutubeFollowUps(
  request: YoutubeFollowUpRequest,
  deps: YoutubeFollowUpDeps,
): Promise<YoutubeFollowUpResults> {
  const thumbnail = request.thumbnailUrl
    ? await setYoutubeThumbnail(request.videoId, request.accessToken, request.thumbnailUrl, deps)
    : NOT_REQUESTED;
  const first_comment = request.firstComment
    ? await postYoutubeFirstComment(request.videoId, request.channelId, request.accessToken, request.firstComment, deps)
    : NOT_REQUESTED;
  const playlist = request.playlistId
    ? await addToYoutubePlaylist(request.videoId, request.channelId, request.accessToken, request.playlistId, deps)
    : NOT_REQUESTED;
  const caption = request.caption !== undefined && request.caption !== null
    ? await uploadYoutubeCaption(request.videoId, request.accessToken, request.caption, deps)
    : NOT_REQUESTED;
  return { thumbnail, first_comment, playlist, caption };
}

async function setYoutubeThumbnail(
  videoId: string,
  accessToken: string,
  thumbnailUrl: string,
  deps: YoutubeFollowUpDeps,
): Promise<YoutubeFollowUpOutcome> {
  const budgetMs = deps.budgetMs();
  if (budgetMs <= 0) {
    console.warn("YouTube thumbnail skipped: the worker has no time left for it");
    return { state: "skipped", reason: "no_time" };
  }
  try {
    const { blob, mimeType } = await deps.downloadThumbnail(thumbnailUrl, budgetMs);
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
    const uploadBudgetMs = deps.budgetMs();
    if (uploadBudgetMs <= 0) return { state: "skipped", reason: "no_time" };
    const response = await deps.fetchImpl(`${THUMBNAIL_ENDPOINT}?videoId=${videoId}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": mimeType,
      },
      body: blob,
      signal: AbortSignal.timeout(uploadBudgetMs),
    });
    if (response.ok) {
      console.log("YouTube thumbnail set successfully");
      return { state: "applied", reason: null };
    }
    console.warn("Failed to set YouTube thumbnail:", redactProviderText(await response.text()));
    return { state: "failed", reason: "refused" };
  } catch (error) {
    console.warn("Error setting YouTube thumbnail:", redactProviderText(error));
    return { state: "unknown", reason: "answer_lost" };
  }
}

async function postYoutubeFirstComment(
  videoId: string,
  channelId: string,
  accessToken: string,
  firstComment: string,
  deps: YoutubeFollowUpDeps,
): Promise<YoutubeFollowUpOutcome> {
  try {
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
    const budgetMs = deps.budgetMs();
    if (budgetMs <= 0) return { state: "skipped", reason: "no_time" };
    console.log("Posting first comment to YouTube video...");
    const response = await deps.fetchImpl(COMMENT_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snippet: {
          videoId,
          // Google requires the channel that owns the video; omitting it can
          // post to the wrong channel when the account manages several.
          channelId,
          topLevelComment: {
            snippet: {
              textOriginal: firstComment,
            },
          },
        },
      }),
      signal: AbortSignal.timeout(budgetMs),
    });
    if (response.ok) {
      console.log("First comment posted successfully");
      return { state: "applied", reason: null };
    }
    console.warn("Failed to post first comment:", redactProviderText(await response.text()));
    return { state: "failed", reason: "refused" };
  } catch (error) {
    // The comment is posted ONCE, and it is never retried: a first
    // comment posted twice is a duplicate on the customer's channel, and a
    // timeout says nothing about whether the first one arrived.
    console.warn("Error posting first comment:", redactProviderText(error));
    return { state: "unknown", reason: "answer_lost" };
  }
}

async function verifyPlaylistOwnership(
  playlistId: string,
  channelId: string,
  accessToken: string,
  timeoutMs: number,
  fetchImpl: typeof fetch,
): Promise<YoutubeFollowUpOutcome | null> {
  try {
    const response = await fetchImpl(
      `${PLAYLISTS_PRECHECK_ENDPOINT}?part=snippet&id=${encodeURIComponent(playlistId)}`,
      {
        method: "GET",
        headers: { Authorization: `Bearer ${accessToken}` },
        signal: AbortSignal.timeout(timeoutMs),
      },
    );
    if (!response.ok) {
      return {
        state: "failed",
        reason: response.status === 404 || response.status === 403 ? "not_owned" : "refused",
      };
    }
    const body = await response.json().catch(() => null) as {
      items?: Array<{ id?: unknown; snippet?: { channelId?: unknown } }>;
    } | null;
    const item = Array.isArray(body?.items)
      ? body.items.find((entry) => entry?.id === playlistId)
      : undefined;
    if (!item || item.snippet?.channelId !== channelId) {
      return { state: "failed", reason: "not_owned" };
    }
    return null;
  } catch (error) {
    console.warn("Error verifying YouTube playlist ownership:", redactProviderText(error));
    return { state: "failed", reason: "refused" };
  }
}

async function addToYoutubePlaylist(
  videoId: string,
  channelId: string,
  accessToken: string,
  playlistId: string,
  deps: YoutubeFollowUpDeps,
): Promise<YoutubeFollowUpOutcome> {
  if (!PLAYLIST_ID_PATTERN.test(playlistId)) {
    return { state: "failed", reason: "not_owned" };
  }
  const precheckBudgetMs = deps.budgetMs();
  if (precheckBudgetMs <= 0) return { state: "skipped", reason: "no_time" };
  try {
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
  } catch (error) {
    console.warn("Error checking write authority before YouTube playlist precheck:", redactProviderText(error));
    return { state: "skipped", reason: "authority_lost" };
  }

  const ownershipFailure = await verifyPlaylistOwnership(
    playlistId,
    channelId,
    accessToken,
    precheckBudgetMs,
    deps.fetchImpl,
  );
  if (ownershipFailure) return ownershipFailure;

  try {
    if (!deps.debitWriteBudget || !await deps.debitWriteBudget(PLAYLIST_INSERT_UNIT_COST)) {
      return { state: "skipped", reason: "quota_budget" };
    }
  } catch (error) {
    console.warn("Error debiting YouTube write budget for playlist insert:", redactProviderText(error));
    return { state: "skipped", reason: "quota_budget" };
  }
  try {
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
  } catch (error) {
    console.warn("Error checking write authority before YouTube playlist insert:", redactProviderText(error));
    return { state: "skipped", reason: "authority_lost" };
  }
  const insertBudgetMs = deps.budgetMs();
  if (insertBudgetMs <= 0) return { state: "skipped", reason: "no_time" };

  try {
    const response = await deps.fetchImpl(PLAYLIST_ITEMS_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        snippet: {
          playlistId,
          resourceId: { kind: "youtube#video", videoId },
        },
      }),
      signal: AbortSignal.timeout(insertBudgetMs),
    });
    if (response.ok) {
      console.log("Video added to YouTube playlist successfully");
      return { state: "applied", reason: null };
    }
    console.warn("Failed to add video to playlist:", redactProviderText(await response.text()));
    return { state: "failed", reason: "refused" };
  } catch (error) {
    // Never retry playlistItems.insert: a second call adds the video twice.
    console.warn("Error adding video to playlist:", redactProviderText(error));
    return { state: "unknown", reason: "answer_lost" };
  }
}

function isCaptionInputCandidate(value: unknown): value is YoutubeCaptionFollowUpInput {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.language === "string" &&
    typeof record.name === "string" &&
    (record.format === "srt" || record.format === "vtt") &&
    typeof record.content === "string"
  );
}

async function uploadYoutubeCaption(
  videoId: string,
  accessToken: string,
  caption: unknown,
  deps: YoutubeFollowUpDeps,
): Promise<YoutubeFollowUpOutcome> {
  // 1. Validate caption input — free.
  if (!isCaptionInputCandidate(caption) || !validateCaptionUploadInput(caption).ok) {
    return { state: "skipped", reason: "invalid_caption" };
  }

  // 1a. Scope (`D-P7-4`) — free. Requires youtube.force-ssl in granted_scopes.
  if (!deps.hasCaptionScope || !deps.hasCaptionScope()) {
    return { state: "skipped", reason: "missing_scope" };
  }

  // 2. Time budget check.
  const initialBudgetMs = deps.budgetMs();
  if (initialBudgetMs <= 0) {
    return { state: "skipped", reason: "no_time" };
  }

  // 3. Authority check.
  try {
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
  } catch {
    return { state: "skipped", reason: "authority_lost" };
  }

  // 4. Per-user daily caption upload allowance (2 / 24 h).
  try {
    if (!deps.checkCaptionUploadAllowance || !await deps.checkCaptionUploadAllowance()) {
      return { state: "skipped", reason: "rate_limited" };
    }
  } catch {
    return { state: "skipped", reason: "rate_limited" };
  }

  // 5. Project write budget (400 units).
  try {
    if (!deps.debitWriteBudget || !await deps.debitWriteBudget(CAPTION_INSERT_UNIT_COST)) {
      return { state: "skipped", reason: "quota_budget" };
    }
  } catch {
    return { state: "skipped", reason: "quota_budget" };
  }

  // 6. Re-check write authority and remaining time before sending the provider write.
  try {
    if (!await deps.canWrite()) return { state: "skipped", reason: "authority_lost" };
  } catch {
    return { state: "skipped", reason: "authority_lost" };
  }
  const uploadBudgetMs = deps.budgetMs();
  if (uploadBudgetMs <= 0) {
    return { state: "skipped", reason: "no_time" };
  }

  // 7. Build multipart body with explicit boundary and send one POST.
  const boundary = `---postora-caption-${crypto.randomUUID()}`;
  const snippetJson = JSON.stringify({
    snippet: {
      videoId,
      language: caption.language,
      name: caption.name,
      isDraft: false,
    },
  });
  const trackContentType = caption.format === "srt" ? "application/x-subrip" : "text/vtt";
  const multipartBody = [
    `--${boundary}`,
    "Content-Type: application/json; charset=UTF-8",
    "",
    snippetJson,
    `--${boundary}`,
    `Content-Type: ${trackContentType}; charset=UTF-8`,
    "",
    caption.content,
    `--${boundary}--`,
    "",
  ].join("\r\n");

  try {
    const response = await deps.fetchImpl(CAPTIONS_UPLOAD_ENDPOINT, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": `multipart/related; boundary=${boundary}`,
      },
      body: multipartBody,
      signal: AbortSignal.timeout(Math.min(uploadBudgetMs, CAPTION_MAX_TIMEOUT_MS)),
    });

    if (response.ok) {
      await response.body?.cancel().catch(() => {});
      return { state: "applied", reason: null };
    }

    await response.body?.cancel().catch(() => {});
    if (response.status === 409) {
      console.warn("YouTube caption upload failed: status=409 code=conflict");
      return { state: "failed", reason: "conflict" };
    }

    console.warn(`YouTube caption upload failed: status=${response.status} code=refused`);
    return { state: "failed", reason: "refused" };
  } catch {
    // Sent once and never retried; never log caption content or raw error bodies (`D-P7-4`).
    console.warn("YouTube caption upload error: code=answer_lost");
    return { state: "unknown", reason: "answer_lost" };
  }
}
