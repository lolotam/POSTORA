import { canTransition, consentKey, reviewBlockers, type ReviewBlocker } from "./reviewRules";
import { validateScheduledAt } from "./scheduleRules";
import type { CreatorInfo, ReviewDraft, SubmitReviewCommand } from "./types";

export type Confirmation = { key: string; caption: string; consent: boolean };

export function evaluateSubmission(
  draft: ReviewDraft | null,
  creator: CreatorInfo | null,
  confirmation: Confirmation | null,
  mode: SubmitReviewCommand["mode"],
  scheduledAt: string | null,
  now: Date,
  captionDirty: boolean,
): ReviewBlocker[] {
  if (!draft) return [{ code: "DRAFT_REQUIRED", message: "Select a post to review it." }];
  if (!canTransition(draft.state, "submit")) {
    return [{ code: "CANNOT_SUBMIT", message: "This post cannot be published from its current state." }];
  }
  if (captionDirty) return [{ code: "UNSAVED_EDITS", message: "Save or cancel your caption edit first." }];
  if (mode === "scheduled" && scheduledAt) {
    const verdict = validateScheduledAt(scheduledAt, now);
    if (verdict !== "ok") {
      return [{
        code: verdict === "past" ? "SCHEDULE_TIME_PAST" : "SCHEDULE_TIME_INVALID",
        message: verdict === "past" ? "Choose a future time." : "That time is not valid.",
      }];
    }
  }
  const key = consentKey(draft.id, draft.accountId, draft.revision, draft.mediaFileId, draft.settings);
  const confirmed = confirmation?.key === key && confirmation.caption === draft.caption;
  return reviewBlockers({
    caption: draft.caption,
    settings: draft.settings,
    mediaFileId: draft.mediaFileId,
    durationSec: draft.mediaDurationSec,
    creator,
    settingsConfirmed: confirmed,
    consentGranted: confirmed && confirmation?.consent === true,
    mode,
    scheduledAt: mode === "scheduled" ? scheduledAt : null,
  });
}
