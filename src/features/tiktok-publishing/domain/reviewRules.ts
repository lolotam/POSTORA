import type { CreatorInfo, ReviewState, TikTokSettings } from "./types";

export type PolicyBlockerCode =
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

export type ClientBlockerCode =
  | "CREATOR_INFO_UNAVAILABLE"
  | "SETTINGS_NOT_CONFIRMED"
  | "CONSENT_REQUIRED"
  | "SCHEDULE_TIME_REQUIRED";

export type ReviewBlockerCode = PolicyBlockerCode | ClientBlockerCode;

export interface ReviewBlocker {
  code: ReviewBlockerCode;
  message: string;
}

export interface ReviewBlockerInput {
  caption: string;
  settings: TikTokSettings;
  mediaFileId: string | null;
  durationSec: number | null;
  creator: CreatorInfo | null;
  settingsConfirmed: boolean;
  consentGranted: boolean;
  mode: "now" | "scheduled";
  scheduledAt: string | null;
}

export type ReviewTransition = "reject" | "archive" | "restore" | "edit" | "save" | "submit";

const CAPTION_LIMIT = 2200;

const PRIVACY_LABELS: Record<string, string> = {
  PUBLIC_TO_EVERYONE: "Everyone",
  MUTUAL_FOLLOW_FRIENDS: "Friends",
  FOLLOWER_OF_CREATOR: "Followers",
  SELF_ONLY: "Only me",
};

export function privacyLabel(level: string): string {
  return PRIVACY_LABELS[level] ?? level;
}

export function defaultSettings(): TikTokSettings {
  return {
    privacy: null,
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  };
}

export function reviewBlockers(input: ReviewBlockerInput): ReviewBlocker[] {
  const blockers: ReviewBlocker[] = [];
  const { creator, settings } = input;

  if (creator?.postingBlocked) {
    const reason = creator.postingBlockedReason?.trim();
    blockers.push({
      code: "POSTING_BLOCKED",
      message: reason || "TikTok is not allowing posts from this account right now.",
    });
  }
  if (!input.mediaFileId) {
    blockers.push({ code: "MEDIA_REQUIRED", message: "Add a video before publishing." });
  }
  if (!settings.privacy) {
    blockers.push({ code: "PRIVACY_REQUIRED", message: "Choose who can view this TikTok post." });
  }
  if (creator && settings.privacy && !creator.privacyLevelOptions.includes(settings.privacy)) {
    blockers.push({
      code: "PRIVACY_NOT_OFFERED",
      message: "That audience is not available for this account.",
    });
  }
  if (creator?.commentDisabled && settings.allowComment) {
    blockers.push({
      code: "COMMENT_NOT_ALLOWED",
      message: "Comments are turned off for this TikTok account.",
    });
  }
  if (creator?.duetDisabled && settings.allowDuet) {
    blockers.push({
      code: "DUET_NOT_ALLOWED",
      message: "Duet is turned off for this TikTok account.",
    });
  }
  if (creator?.stitchDisabled && settings.allowStitch) {
    blockers.push({
      code: "STITCH_NOT_ALLOWED",
      message: "Stitch is turned off for this TikTok account.",
    });
  }
  if (settings.disclose && !settings.yourBrand && !settings.brandedContent) {
    blockers.push({ code: "DISCLOSURE_INCOMPLETE", message: "Select at least one." });
  }
  if (settings.brandedContent && settings.privacy === "SELF_ONLY") {
    blockers.push({
      code: "BRANDED_CONTENT_PRIVATE",
      message: "Branded content visibility cannot be set to private.",
    });
  }
  if (input.caption.length > CAPTION_LIMIT) {
    blockers.push({
      code: "CAPTION_TOO_LONG",
      message: "Caption must be 2200 characters or fewer.",
    });
  }
  if (input.mediaFileId && input.durationSec === null) {
    blockers.push({
      code: "DURATION_UNKNOWN",
      message: "Video length could not be read. Choose the video again.",
    });
  }
  if (
    creator
    && input.durationSec !== null
    && input.durationSec > creator.maxVideoPostDurationSec
  ) {
    blockers.push({
      code: "DURATION_EXCEEDED",
      message: `Video is longer than the maximum of ${creator.maxVideoPostDurationSec} seconds.`,
    });
  }
  if (!creator) {
    blockers.push({
      code: "CREATOR_INFO_UNAVAILABLE",
      message: "TikTok account details could not be loaded.",
    });
  }
  if (!input.settingsConfirmed) {
    blockers.push({
      code: "SETTINGS_NOT_CONFIRMED",
      message: "Open TikTok settings and confirm this post for the selected account.",
    });
  }
  if (!input.consentGranted) {
    blockers.push({
      code: "CONSENT_REQUIRED",
      message: "Consent is required before this post can be sent.",
    });
  }
  if (input.mode === "scheduled" && !input.scheduledAt) {
    blockers.push({
      code: "SCHEDULE_TIME_REQUIRED",
      message: "Pick a time to enable schedule.",
    });
  }
  return blockers;
}

/** Stable across browsers. Consent is valid only while this equals the key it was granted for. */
export function consentKey(
  accountId: string,
  revision: number,
  mediaFileId: string | null,
  settings: TikTokSettings,
  mode: "now" | "scheduled",
  scheduledAt: string | null,
): string {
  const settingsToken = [
    settings.privacy ?? "",
    settings.allowComment ? "1" : "0",
    settings.allowDuet ? "1" : "0",
    settings.allowStitch ? "1" : "0",
    settings.disclose ? "1" : "0",
    settings.yourBrand ? "1" : "0",
    settings.brandedContent ? "1" : "0",
    settings.aiGenerated ? "1" : "0",
  ].join(",");
  return [
    accountId,
    String(revision),
    mediaFileId ?? "",
    settingsToken,
    mode,
    scheduledAt ?? "",
  ].join("|");
}

/** Drops choices the creator cannot honor. Never enables a flag that was off. */
export function sanitizeSettingsForCreator(settings: TikTokSettings, creator: CreatorInfo): TikTokSettings {
  const privacy = settings.privacy && creator.privacyLevelOptions.includes(settings.privacy)
    ? settings.privacy
    : null;
  return {
    privacy,
    allowComment: creator.commentDisabled ? false : settings.allowComment,
    allowDuet: creator.duetDisabled ? false : settings.allowDuet,
    allowStitch: creator.stitchDisabled ? false : settings.allowStitch,
    disclose: settings.disclose,
    yourBrand: settings.yourBrand,
    brandedContent: privacy === "SELF_ONLY" ? false : settings.brandedContent,
    aiGenerated: settings.aiGenerated,
  };
}

export function musicConsentText(settings: TikTokSettings): string {
  if (settings.disclose && settings.brandedContent) {
    return "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.";
  }
  return "By posting, you agree to TikTok's Music Usage Confirmation.";
}

export function canTransition(state: ReviewState, action: ReviewTransition): boolean {
  switch (action) {
    case "reject":
      return state === "pending_review";
    case "archive":
      return state === "pending_review" || state === "rejected";
    case "restore":
      return state === "archived";
    case "edit":
    case "save":
      return state === "pending_review" || state === "rejected";
    case "submit":
      return state === "pending_review";
    default: {
      const unreachable: never = action;
      return unreachable;
    }
  }
}
