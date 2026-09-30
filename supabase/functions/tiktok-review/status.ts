import { containsSensitiveInfo, sanitizeErrorMessage } from "../_shared/errorSanitizer.ts";

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

/** Same sentences as the publish-policy module, keyed by the code process-post stores after the prefix. */
const ATTENTION_SENTENCES: Record<string, string> = {
  POSTING_BLOCKED: "TikTok is blocking new posts from this account.",
  MEDIA_REQUIRED: "Add a video before publishing.",
  PRIVACY_REQUIRED: "Choose who can view this post.",
  PRIVACY_NOT_OFFERED: "This privacy setting isn't available for this account.",
  COMMENT_NOT_ALLOWED: "Comments can't be turned on for this account.",
  DUET_NOT_ALLOWED: "Duet can't be turned on for this account.",
  STITCH_NOT_ALLOWED: "Stitch can't be turned on for this account.",
  DISCLOSURE_INCOMPLETE: "Indicate whether this promotes you, a third party, or both.",
  BRANDED_CONTENT_PRIVATE: "Branded content can't be set to Only me.",
  CAPTION_TOO_LONG: "Caption must be 2,200 characters or fewer.",
  DURATION_UNKNOWN: "Video length is required before publishing.",
  DURATION_EXCEEDED: "This video is longer than this account can post.",
};

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
  const rest = errorMessage.trim().startsWith(ATTENTION_PREFIX)
    ? errorMessage.trim().slice(ATTENTION_PREFIX.length).replace(/^[:\s]+/, "").trim()
    : "";
  const known = ATTENTION_SENTENCES[rest];
  if (known) return known;
  if (rest.length === 0 || /^[A-Z0-9_]+$/.test(rest) || containsSensitiveInfo(rest)) {
    return GENERIC_ATTENTION;
  }
  const sentence = /[.!?]$/.test(rest) ? rest : `${rest}.`;
  return sentence.length > 300 ? sentence.slice(0, 300) : sentence;
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
  if (submission.dispatchState === "unknown" || submission.dispatchState === "needs_attention") {
    const reason = submission.dispatchState === "unknown"
      ? "Publishing did not confirm it started."
      : "This post needs attention before it can go out.";
    return statusOf("needs_attention", updatedAt, reason, null);
  }
  if (submission.dispatchState === "dispatching") {
    const updatedMs = Date.parse(submission.updatedAt);
    const age = input.nowMs - updatedMs;
    if (!Number.isFinite(updatedMs) || age > DISPATCH_STALE_MS) {
      return statusOf("needs_attention", updatedAt, "Publishing did not confirm it started.", null);
    }
  }
  return statusOf("queued", updatedAt, null, null);
}
