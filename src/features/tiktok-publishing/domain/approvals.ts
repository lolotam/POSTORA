import { privacyLabel, type ReviewBlocker, type ReviewBlockerCode } from "./reviewRules";
import type { PublishState, ReviewState, TikTokSettings } from "./types";

/** Approvals page filter (`?tab=`). "Approved" means the post was sent to TikTok (state `submitted`). */
export type ApprovalsTab = "pending" | "approved" | "rejected" | "all";

export const APPROVALS_TABS: readonly ApprovalsTab[] = ["pending", "approved", "rejected", "all"];

const TAB_STATES: Record<ApprovalsTab, readonly ReviewState[]> = {
  pending: ["pending_review"],
  approved: ["submitted"],
  rejected: ["rejected"],
  all: ["pending_review", "submitted", "rejected", "archived"],
};

export function statesForTab(tab: ApprovalsTab): readonly ReviewState[] {
  return TAB_STATES[tab];
}

export function parseApprovalsTab(value: string | null): ApprovalsTab {
  return APPROVALS_TABS.includes(value as ApprovalsTab) ? (value as ApprovalsTab) : "pending";
}

const SETTINGS_CODES: ReadonlySet<ReviewBlockerCode> = new Set<ReviewBlockerCode>([
  "PRIVACY_REQUIRED",
  "PRIVACY_NOT_OFFERED",
  "COMMENT_NOT_ALLOWED",
  "DUET_NOT_ALLOWED",
  "STITCH_NOT_ALLOWED",
  "DISCLOSURE_INCOMPLETE",
  "BRANDED_CONTENT_PRIVATE",
  "SETTINGS_NOT_CONFIRMED",
  "CONSENT_REQUIRED",
]);

/** True when something only the TikTok settings popover can fix is blocking Approve. Drives the red dot. */
export function settingsNeedAttention(blockers: readonly ReviewBlocker[]): boolean {
  return blockers.some((blocker) => SETTINGS_CODES.has(blocker.code));
}

/** "Friends · Video · Comments on", the facts-row summary of a draft's TikTok settings. */
export function tiktokSummary(settings: TikTokSettings): string {
  const audience = settings.privacy ? privacyLabel(settings.privacy) : "Choose audience";
  const comments = settings.allowComment ? "Comments on" : "Comments off";
  return `${audience} · Video · ${comments}`;
}

export type StatusTone = "neutral" | "mint" | "ink" | "tomato" | "highlight" | "mute";

export interface StatusView {
  /** Uppercase pill text in lists. */
  pill: string;
  /** Detail-header tag text. */
  tag: string;
  tone: StatusTone;
}

/**
 * One status for a draft, folding in the publish outcome once it was sent.
 * `publish` is null while the outcome is unknown (not sent, or not loaded yet).
 */
export function draftStatus(state: ReviewState, publish: PublishState | null): StatusView {
  switch (state) {
    case "pending_review":
      return { pill: "Pending", tag: "Awaiting review", tone: "highlight" };
    case "rejected":
      return { pill: "Rejected", tag: "Rejected", tone: "tomato" };
    case "archived":
      return { pill: "Archived", tag: "Archived", tone: "mute" };
    case "submitted":
      return submittedStatus(publish);
    default: {
      const unreachable: never = state;
      return unreachable;
    }
  }
}

function submittedStatus(publish: PublishState | null): StatusView {
  switch (publish) {
    case "published":
      return { pill: "Published", tag: "Published", tone: "ink" };
    case "failed":
    case "needs_attention":
      return { pill: "Publish failed", tag: "Publish failed", tone: "tomato" };
    case "scheduled":
      return { pill: "Scheduled", tag: "Scheduled", tone: "mint" };
    case "queued":
    case "processing":
      return { pill: "Publishing", tag: "Publishing", tone: "mint" };
    case null:
      return { pill: "Approved", tag: "Approved", tone: "mint" };
    default: {
      const unreachable: never = publish;
      return unreachable;
    }
  }
}

/** Hashtags typed in the editor ("brand, launch story") as caption tags: "#brand #launch #story". */
export function hashtagsToAppend(input: string, caption: string): string {
  const existing = new Set((caption.match(/#[\p{L}\p{N}_]+/gu) ?? []).map((tag) => tag.toLowerCase()));
  const tags = input
    .split(/[\s,]+/)
    .map((word) => word.replace(/^#+/, "").trim())
    .filter((word) => /^[\p{L}\p{N}_]+$/u.test(word))
    .map((word) => `#${word}`)
    .filter((tag) => {
      const key = tag.toLowerCase();
      if (existing.has(key)) return false;
      existing.add(key);
      return true;
    });
  return tags.join(" ");
}
