/**
 * Strict publish gate for TikTok review posts.
 *
 * Shared by the review handler (before submit) and process-post (review-origin
 * posts only) so the two paths cannot disagree. Pure: no I/O and no clock.
 */
import type { TikTokPostSettings } from "./tiktokPostInfo.ts";

/** Same fields as {@link TikTokPostSettings}, but privacy may still be unset. */
export type TikTokReviewSettings = Omit<TikTokPostSettings, "privacy"> & {
  readonly privacy: string | null;
};

export type TikTokCreatorCapabilities = {
  readonly privacyLevelOptions: readonly string[];
  readonly commentDisabled: boolean;
  readonly duetDisabled: boolean;
  readonly stitchDisabled: boolean;
  readonly maxVideoPostDurationSec: number;
  readonly postingBlocked: boolean;
};

export type PolicyViolationCode =
  | "POSTING_BLOCKED"
  | "MEDIA_REQUIRED"
  | "PRIVACY_REQUIRED"
  | "PRIVACY_NOT_OFFERED"
  | "COMMENT_NOT_ALLOWED"
  | "DUET_NOT_ALLOWED"
  | "STITCH_NOT_ALLOWED"
  | "DISCLOSURE_INCOMPLETE"
  | "BRANDED_CONTENT_PRIVATE"
  | "CAPTION_TOO_LONG"
  | "DURATION_UNKNOWN"
  | "DURATION_EXCEEDED";

export type PolicyViolation = {
  readonly code: PolicyViolationCode;
  readonly message: string;
};

/**
 * TikTok counts `post_info.title` in UTF-16 code units. JavaScript
 * `string.length` is that unit, so it is the limit — not Unicode code points.
 */
export const TIKTOK_CAPTION_MAX_UTF16 = 2200;

const VIOLATION_MESSAGES: Record<PolicyViolationCode, string> = {
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

export type TikTokPublishPolicyInput = {
  readonly caption: string;
  readonly settings: TikTokReviewSettings;
  readonly mediaFileId: string | null;
  readonly durationSec: number | null;
  readonly creator: TikTokCreatorCapabilities;
};

function violation(code: PolicyViolationCode): PolicyViolation {
  return { code, message: VIOLATION_MESSAGES[code] };
}

function isPositiveFiniteNumber(value: number | null): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

/**
 * Every failing rule is reported. An empty array means the snapshot may be submitted.
 * Duration is skipped when media is missing because MEDIA_REQUIRED already covers it.
 */
export function evaluateTikTokPublishPolicy(
  input: TikTokPublishPolicyInput,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const { settings, creator } = input;
  const mediaMissing = input.mediaFileId === null || input.mediaFileId.length === 0;

  if (creator.postingBlocked) {
    violations.push(violation("POSTING_BLOCKED"));
  }
  if (mediaMissing) {
    violations.push(violation("MEDIA_REQUIRED"));
  }

  const privacy = settings.privacy;
  if (privacy === null || privacy.length === 0) {
    violations.push(violation("PRIVACY_REQUIRED"));
  } else if (!creator.privacyLevelOptions.includes(privacy)) {
    violations.push(violation("PRIVACY_NOT_OFFERED"));
  }

  if (settings.allowComment && creator.commentDisabled) {
    violations.push(violation("COMMENT_NOT_ALLOWED"));
  }
  if (settings.allowDuet && creator.duetDisabled) {
    violations.push(violation("DUET_NOT_ALLOWED"));
  }
  if (settings.allowStitch && creator.stitchDisabled) {
    violations.push(violation("STITCH_NOT_ALLOWED"));
  }

  if (settings.disclose && !settings.yourBrand && !settings.brandedContent) {
    violations.push(violation("DISCLOSURE_INCOMPLETE"));
  }
  if (
    settings.disclose &&
    settings.brandedContent &&
    settings.privacy === "SELF_ONLY"
  ) {
    violations.push(violation("BRANDED_CONTENT_PRIVATE"));
  }

  if (input.caption.length > TIKTOK_CAPTION_MAX_UTF16) {
    violations.push(violation("CAPTION_TOO_LONG"));
  }

  if (!mediaMissing) {
    if (!isPositiveFiniteNumber(input.durationSec)) {
      violations.push(violation("DURATION_UNKNOWN"));
    } else if (input.durationSec > creator.maxVideoPostDurationSec) {
      violations.push(violation("DURATION_EXCEEDED"));
    }
  }

  return violations;
}

/**
 * Maps TikTok `creator_info` `data` into capabilities.
 * Returns null when the privacy list or the duration cap is unusable, so a
 * failed provider read stays an error instead of an empty allow-list.
 * `postingBlocked` stays false: callers set it from blocking error codes.
 */
export function creatorCapabilitiesFromTikTok(
  data: unknown,
): TikTokCreatorCapabilities | null {
  if (!isRecord(data)) return null;

  const privacyLevelOptions = data.privacy_level_options;
  const maxVideoPostDurationSec = data.max_video_post_duration_sec;
  if (!isStringArray(privacyLevelOptions)) return null;
  if (
    typeof maxVideoPostDurationSec !== "number" ||
    !Number.isFinite(maxVideoPostDurationSec) ||
    maxVideoPostDurationSec <= 0
  ) {
    return null;
  }

  return {
    privacyLevelOptions,
    commentDisabled: data.comment_disabled === true,
    duetDisabled: data.duet_disabled === true,
    stitchDisabled: data.stitch_disabled === true,
    maxVideoPostDurationSec,
    postingBlocked: false,
  };
}
