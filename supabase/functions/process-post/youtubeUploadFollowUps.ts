/**
 * The things that happen AFTER the video exists: the thumbnail and the first
 * comment.
 *
 * They belong to the run that CREATED the video. Two runs can reach a video:
 * the one that uploaded it, and the one that inherited its receipt after an
 * interruption. Only the first one does the follow-ups, because a first
 * comment posted twice is a duplicate on the customer's channel.
 *
 * Neither follow-up is allowed to fail the publish. The video is already
 * live, and the public row has to be settled either way, so a failure is
 * logged and the publish carries on.
 *
 * Both follow-ups are best-effort requests, so both are bounded by what is
 * left of the worker: a follow-up that runs out of time is skipped, and the
 * video is still recorded. A follow-up that never ends would take the worker
 * with it, and the outcome would never be written at all.
 */

import { redactProviderText } from "./youtubeUploadPolicy.ts";

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
}

const THUMBNAIL_ENDPOINT = "https://www.googleapis.com/upload/youtube/v3/thumbnails/set";
const COMMENT_ENDPOINT = "https://www.googleapis.com/youtube/v3/commentThreads?part=snippet";

/**
 * The follow-ups of one video.
 *
 * Each follow-up asks for the time that is left for itself, so the second one
 * is skipped rather than started when the worker has already run out of time.
 */
export async function runYoutubeFollowUps(
  request: YoutubeFollowUpRequest,
  deps: YoutubeFollowUpDeps,
): Promise<void> {
  if (request.thumbnailUrl) {
    await setYoutubeThumbnail(request.videoId, request.accessToken, request.thumbnailUrl, deps);
  }
  if (request.firstComment) {
    await postYoutubeFirstComment(request.videoId, request.channelId, request.accessToken, request.firstComment, deps);
  }
}

async function setYoutubeThumbnail(
  videoId: string,
  accessToken: string,
  thumbnailUrl: string,
  deps: YoutubeFollowUpDeps,
): Promise<void> {
  const budgetMs = deps.budgetMs();
  if (budgetMs <= 0) {
    console.warn("YouTube thumbnail skipped: the worker has no time left for it");
    return;
  }
  try {
    const { blob, mimeType } = await deps.downloadThumbnail(thumbnailUrl, budgetMs);
    if (!await deps.canWrite()) return;
    const uploadBudgetMs = deps.budgetMs();
    if (uploadBudgetMs <= 0) return;
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
    } else {
      console.warn("Failed to set YouTube thumbnail:", redactProviderText(await response.text()));
    }
  } catch (error) {
    console.warn("Error setting YouTube thumbnail:", redactProviderText(error));
  }
}

async function postYoutubeFirstComment(
  videoId: string,
  channelId: string,
  accessToken: string,
  firstComment: string,
  deps: YoutubeFollowUpDeps,
): Promise<void> {
  try {
    if (!await deps.canWrite()) return;
    const budgetMs = deps.budgetMs();
    if (budgetMs <= 0) return;
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
    } else {
      console.warn("Failed to post first comment:", redactProviderText(await response.text()));
    }
  } catch (error) {
    // The comment is posted ONCE, and it is never retried: a first
    // comment posted twice is a duplicate on the customer's channel, and a
    // timeout says nothing about whether the first one arrived.
    console.warn("Error posting first comment:", redactProviderText(error));
  }
}
