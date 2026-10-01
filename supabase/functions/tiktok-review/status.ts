import { sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";

import { isPolicyViolationCode, policyViolationMessage } from "../_shared/tiktokPublishPolicy.ts";

export type PublishState =
  | "scheduled"
  | "queued"
  | "processing"
  | "published"
  | "failed"
  | "needs_attention";

export type PublishStatus = {
  state: PublishState;
  updatedAt: string;
  reason: string | null;
  postUrl: string | null;
};

export type PlatformPostSnapshot = {
  status: string | null;
  platformPostUrl: string | null;
  errorMessage: string | null;
  createdAt: string | null;
  postedAt: string | null;
};

export type PostSnapshot = {
  status: string | null;
  createdAt: string | null;
  postedAt: string | null;
  scheduledAt: string | null;
};

export type SubmissionSnapshot = {
  dispatchState: string;
  updatedAt: string;
  providerPublishId?: string | null;
};

export type MapPublishStatusInput = {
  platformPost: PlatformPostSnapshot | null;
  post: PostSnapshot;
  submission: SubmissionSnapshot;
  nowMs: number;
};

const ATTENTION_PREFIX = "TIKTOK_REVIEW_NEEDS_ATTENTION";
const DISPATCH_STALE_MS = 5 * 60 * 1000;
const GENERIC_ATTENTION = "These settings are no longer allowed. Review them before trying again.";

function newestIso(values: Array<string | null | undefined>, fallback: string): string {
  let bestValue = fallback;
  let bestMs = Date.parse(fallback);
  if (!Number.isFinite(bestMs)) bestMs = Number.NEGATIVE_INFINITY;
  for (const value of values) {
    if (!value) continue;
    const ms = Date.parse(value);
    if (Number.isFinite(ms) && ms >= bestMs) {
      bestMs = ms;
      bestValue = value;
    }
  }
  return bestValue;
}

function attentionSentence(errorMessage: string): string {
  const prefix = `${ATTENTION_PREFIX}:`;
  const codes = errorMessage.trim().startsWith(prefix)
    ? errorMessage.trim().slice(prefix.length).split(",").map((code) => code.trim())
    : [];
  const policyCode = codes.find(isPolicyViolationCode);
  if (policyCode) return policyViolationMessage(policyCode);
  for (const code of codes) {
    if (["CREATOR_INFO_UNAVAILABLE", "SUBMISSION_READ_FAILED", "SUBMISSION_NOT_FOUND", "MEDIA_READ_FAILED", "PUBLISH_ID_RECORD_FAILED", "POST_READ_FAILED", "POST_NOT_CLAIMED"].includes(code)) {
      return "TikTok or Postora was temporarily unavailable when publishing. Choose Edit and resubmit in TikTok review to try again.";
    }
    if (code === "ALREADY_DISPATCHED") {
      return "This post can't be retried from History. Open it in TikTok review and choose Edit and resubmit if TikTok didn't receive it.";
    }
    if (code === "SNAPSHOT_MISMATCH") {
      return "This post changed after it was approved. Review it again before publishing.";
    }
  }
  return GENERIC_ATTENTION;
}

function failedReason(errorMessage: string | null): string {
  const sanitized = sanitizeErrorMessage(errorMessage ?? "");
  return sanitized.length > 300 ? sanitized.slice(0, 300) : sanitized;
}

function statusOf(
  state: PublishState,
  updatedAt: string,
  reason: string | null,
  postUrl: string | null,
): PublishStatus {
  return { state, updatedAt, reason, postUrl };
}

/**
 * Pure publish-status mapping. No I/O.
 * A platform row wins over the post and the dispatch state.
 * `dispatching` becomes needs_attention only once `updatedAt` is older than five minutes.
 */
export function mapPublishStatus(input: MapPublishStatusInput): PublishStatus {
  const { platformPost, post, submission } = input;
  const updatedAt = newestIso(
    [
      platformPost?.postedAt,
      platformPost?.createdAt,
      post.postedAt,
      post.createdAt,
      post.scheduledAt,
      submission.updatedAt,
    ],
    submission.updatedAt,
  );

  if (platformPost) {
    if (platformPost.status === "success") {
      return statusOf("published", updatedAt, null, platformPost.platformPostUrl);
    }
    if (platformPost.status === "failed") {
      const message = platformPost.errorMessage ?? "";
      if (message.trim().startsWith(ATTENTION_PREFIX)) {
        return statusOf("needs_attention", updatedAt, attentionSentence(message), null);
      }
      return statusOf("failed", updatedAt, failedReason(platformPost.errorMessage), null);
    }
    return statusOf("processing", updatedAt, null, null);
  }

  if (post.status === "scheduled") return statusOf("scheduled", updatedAt, null, null);
  if (post.status === "failed") {
    return statusOf("failed", updatedAt, "Publishing could not start.", null);
  }
  if (submission.dispatchState === "needs_attention") {
    return statusOf("needs_attention", updatedAt, "This post needs attention before it can go out.", null);
  }
  if (submission.dispatchState === "publishing" && submission.providerPublishId) {
    return statusOf("processing", updatedAt, null, null);
  }
  if (["unknown", "dispatching", "pending_dispatch", "publishing"].includes(submission.dispatchState)) {
    const updatedMs = Date.parse(submission.updatedAt);
    if (!Number.isFinite(updatedMs) || input.nowMs - updatedMs > DISPATCH_STALE_MS) {
      return statusOf("needs_attention", updatedAt, "Publishing did not confirm it started.", null);
    }
    return statusOf(submission.dispatchState === "pending_dispatch" ? "queued" : "processing", updatedAt, null, null);
  }
  return statusOf("queued", updatedAt, null, null);
}
