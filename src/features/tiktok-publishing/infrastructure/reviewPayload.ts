import type {
  CreatorInfo,
  PublishState,
  PublishStatus,
  ReviewDraft,
  ReviewState,
  SubmissionResult,
  TikTokSettings,
} from "../domain/types";
import { ReviewGatewayError } from "../application/ports";

const REVIEW_STATES: readonly ReviewState[] = ["pending_review", "rejected", "archived", "submitted"];
const PUBLISH_STATES: readonly PublishState[] = [
  "scheduled",
  "queued",
  "processing",
  "published",
  "failed",
  "needs_attention",
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new ReviewGatewayError("INTERNAL", `TikTok review response is missing ${field}.`, 500);
  }
  return value;
}

function bool(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") {
    throw new ReviewGatewayError("INTERNAL", `TikTok review response is missing ${field}.`, 500);
  }
  return value;
}

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  return text(value, field);
}

function nullableNumber(value: unknown, field: string): number | null {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ReviewGatewayError("INTERNAL", `TikTok review response is missing ${field}.`, 500);
  }
  return value;
}

export function parseSettings(value: unknown): TikTokSettings {
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing settings.", 500);
  }
  return {
    privacy: nullableText(value.privacy, "settings.privacy"),
    allowComment: bool(value.allowComment, "settings.allowComment"),
    allowDuet: bool(value.allowDuet, "settings.allowDuet"),
    allowStitch: bool(value.allowStitch, "settings.allowStitch"),
    disclose: bool(value.disclose, "settings.disclose"),
    yourBrand: bool(value.yourBrand, "settings.yourBrand"),
    brandedContent: bool(value.brandedContent, "settings.brandedContent"),
    aiGenerated: bool(value.aiGenerated, "settings.aiGenerated"),
  };
}

function parseSubmission(value: unknown): ReviewDraft["submission"] {
  if (value === null) return null;
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing submission.", 500);
  }
  const mode = value.mode;
  if (mode !== "now" && mode !== "scheduled") {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response has an unknown submission mode.", 500);
  }
  return {
    id: text(value.id, "submission.id"),
    postId: text(value.postId, "submission.postId"),
    mode,
    scheduledAt: nullableText(value.scheduledAt, "submission.scheduledAt"),
  };
}

export function parseDraft(value: unknown): ReviewDraft {
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing a draft.", 500);
  }
  const state = value.state;
  if (!REVIEW_STATES.includes(state as ReviewState)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response has an unknown draft state.", 500);
  }
  const revision = value.revision;
  if (typeof revision !== "number" || !Number.isInteger(revision)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing revision.", 500);
  }
  return {
    id: text(value.id, "id"),
    accountId: text(value.accountId, "accountId"),
    revision,
    state: state as ReviewState,
    caption: text(value.caption, "caption"),
    mediaFileId: nullableText(value.mediaFileId, "mediaFileId"),
    mediaDurationSec: nullableNumber(value.mediaDurationSec, "mediaDurationSec"),
    settings: parseSettings(value.settings),
    rejectionReason: nullableText(value.rejectionReason, "rejectionReason"),
    updatedAt: text(value.updatedAt, "updatedAt"),
    submission: parseSubmission(value.submission),
  };
}

export function parseDraftList(value: unknown): ReviewDraft[] {
  if (!Array.isArray(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing the draft list.", 500);
  }
  return value.map(parseDraft);
}

export function parseCreatorInfo(value: unknown): CreatorInfo {
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing creator info.", 500);
  }
  if (!Array.isArray(value.privacyLevelOptions) || !value.privacyLevelOptions.every((item) => typeof item === "string")) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing privacy options.", 500);
  }
  const maxVideoPostDurationSec = value.maxVideoPostDurationSec;
  if (typeof maxVideoPostDurationSec !== "number" || !Number.isFinite(maxVideoPostDurationSec)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing the maximum video length.", 500);
  }
  return {
    nickname: text(value.nickname, "nickname"),
    username: text(value.username, "username"),
    avatarUrl: nullableText(value.avatarUrl, "avatarUrl"),
    privacyLevelOptions: value.privacyLevelOptions,
    commentDisabled: bool(value.commentDisabled, "commentDisabled"),
    duetDisabled: bool(value.duetDisabled, "duetDisabled"),
    stitchDisabled: bool(value.stitchDisabled, "stitchDisabled"),
    maxVideoPostDurationSec,
    postingBlocked: bool(value.postingBlocked, "postingBlocked"),
    postingBlockedReason: nullableText(value.postingBlockedReason, "postingBlockedReason"),
  };
}

export function parseSubmissionResult(value: unknown): SubmissionResult {
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing the submission.", 500);
  }
  const state = value.state;
  if (state !== "queued" && state !== "scheduled") {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response has an unknown submission state.", 500);
  }
  return {
    submissionId: text(value.submissionId, "submissionId"),
    postId: text(value.postId, "postId"),
    state,
  };
}

export function parsePublishStatus(value: unknown): PublishStatus {
  if (!isRecord(value)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response is missing publish status.", 500);
  }
  const state = value.state;
  if (!PUBLISH_STATES.includes(state as PublishState)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review response has an unknown publish state.", 500);
  }
  return {
    state: state as PublishState,
    updatedAt: text(value.updatedAt, "updatedAt"),
    reason: nullableText(value.reason, "reason"),
    postUrl: nullableText(value.postUrl, "postUrl"),
    // Absent until the edge function that sends it is deployed: absent offers no reopen.
    reopenable: value.reopenable === true,
  };
}

export function envelopeError(body: unknown, status: number): ReviewGatewayError {
  if (isRecord(body) && body.ok === false && typeof body.code === "string") {
    const message = typeof body.message === "string" && body.message.trim()
      ? body.message
      : "TikTok review refused the request.";
    return new ReviewGatewayError(body.code, message, status);
  }
  return new ReviewGatewayError("INTERNAL", "TikTok review returned an unreadable error.", status);
}

export function unwrapData(body: unknown): unknown {
  if (!isRecord(body) || body.ok !== true || !("data" in body)) {
    throw new ReviewGatewayError("INTERNAL", "TikTok review returned an unreadable response.", 500);
  }
  return body.data;
}
