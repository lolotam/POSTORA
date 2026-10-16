import { describe, expect, it, test } from "vitest";
import { evaluateSubmission, type Confirmation } from "./evaluateSubmission";
import { consentKey } from "./reviewRules";
import type { CreatorInfo, ReviewDraft } from "./types";

function validCreator(): CreatorInfo {
  return {
    nickname: "Creator Test",
    username: "creator_test",
    avatarUrl: null,
    privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    commentDisabled: false,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 60,
    postingBlocked: false,
    postingBlockedReason: null,
  };
}

function validDraft(overrides: Partial<ReviewDraft> = {}): ReviewDraft {
  return {
    id: "draft-1",
    accountId: "acc-1",
    revision: 1,
    state: "pending_review",
    caption: "Valid caption",
    mediaFileId: "media-1",
    mediaDurationSec: 30,
    settings: {
      privacy: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: false,
      allowStitch: false,
      disclose: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    },
    rejectionReason: null,
    updatedAt: "2026-09-30T12:00:00Z",
    submission: null,
    ...overrides,
  };
}

describe("evaluateSubmission", () => {
  const now = new Date("2026-10-01T12:00:00.000Z");

  function validConfirmation(draft: ReviewDraft): Confirmation {
    const key = consentKey(draft.id, draft.accountId, draft.revision, draft.mediaFileId, draft.settings);
    return {
      key,
      caption: draft.caption,
      consent: true,
    };
  }

  it("returns DRAFT_REQUIRED when draft is null", () => {
    const blockers = evaluateSubmission(null, validCreator(), null, "now", null, now, false);
    expect(blockers).toEqual([
      { code: "DRAFT_REQUIRED", message: "Select a post to review it." },
    ]);
  });

  test.each(["rejected", "archived", "submitted"] as const)(
    "returns CANNOT_SUBMIT when draft is in non-submittable state: %s",
    (state) => {
      const draft = validDraft({ state });
      const blockers = evaluateSubmission(draft, validCreator(), null, "now", null, now, false);
      expect(blockers).toEqual([
        { code: "CANNOT_SUBMIT", message: "This post cannot be published from its current state." },
      ]);
    },
  );

  it("returns UNSAVED_EDITS when captionDirty is true", () => {
    const draft = validDraft();
    const confirmation = validConfirmation(draft);
    const blockers = evaluateSubmission(draft, validCreator(), confirmation, "now", null, now, true);
    expect(blockers).toEqual([
      { code: "UNSAVED_EDITS", message: "Save or cancel your caption edit first." },
    ]);
  });

  it("returns SCHEDULE_TIME_PAST when mode is scheduled and scheduledAt is in the past", () => {
    const draft = validDraft();
    const pastTime = "2026-10-01T11:00:00.000Z";
    const confirmation = validConfirmation(draft);
    const blockers = evaluateSubmission(draft, validCreator(), confirmation, "scheduled", pastTime, now, false);
    expect(blockers).toContainEqual({
      code: "SCHEDULE_TIME_PAST",
      message: "Choose a future time.",
    });
  });

  it("returns SCHEDULE_TIME_INVALID when mode is scheduled and scheduledAt is invalid", () => {
    const draft = validDraft();
    const invalidTime = "invalid-date";
    const confirmation = validConfirmation(draft);
    const blockers = evaluateSubmission(draft, validCreator(), confirmation, "scheduled", invalidTime, now, false);
    expect(blockers).toContainEqual({
      code: "SCHEDULE_TIME_INVALID",
      message: "That time is not valid.",
    });
  });

  test.each([
    ["null confirmation", () => null],
    ["stale key", (draft: ReviewDraft) => ({ key: "stale-key", caption: draft.caption, consent: true })],
    ["caption mismatch", (draft: ReviewDraft) => ({
      key: consentKey(draft.id, draft.accountId, draft.revision, draft.mediaFileId, draft.settings),
      caption: "Mismatched caption that does not equal draft.caption",
      consent: true,
    })],
  ])("returns SETTINGS_NOT_CONFIRMED when %s", (_scenario, makeConfirmation) => {
    const draft = validDraft();
    const confirmation = makeConfirmation(draft);
    const blockers = evaluateSubmission(draft, validCreator(), confirmation, "now", null, now, false);
    expect(blockers).toContainEqual(
      expect.objectContaining({ code: "SETTINGS_NOT_CONFIRMED" }),
    );
  });

  it("keeps a confirmation granted before the publish time was chosen valid for a schedule", () => {
    const draft = validDraft();
    const confirmation = validConfirmation(draft);

    const blockers = evaluateSubmission(
      draft,
      validCreator(),
      confirmation,
      "scheduled",
      "2026-10-02T14:00:00.000Z",
      now,
      false,
    );

    expect(blockers).toEqual([]);
  });

  it("still refuses a confirmation once the draft revision moves on", () => {
    const draft = validDraft();
    const confirmation = validConfirmation(draft);

    const blockers = evaluateSubmission(
      { ...draft, revision: draft.revision + 1 },
      validCreator(),
      confirmation,
      "now",
      null,
      now,
      false,
    );

    expect(blockers).toContainEqual(expect.objectContaining({ code: "SETTINGS_NOT_CONFIRMED" }));
  });

  it("returns CONSENT_REQUIRED when confirmation has consent: false", () => {
    const draft = validDraft();
    const key = consentKey(draft.id, draft.accountId, draft.revision, draft.mediaFileId, draft.settings);
    const noConsentConfirmation: Confirmation = {
      key,
      caption: draft.caption,
      consent: false,
    };
    const blockers = evaluateSubmission(draft, validCreator(), noConsentConfirmation, "now", null, now, false);
    expect(blockers).toContainEqual(
      expect.objectContaining({ code: "CONSENT_REQUIRED" }),
    );
    expect(blockers).not.toContainEqual(
      expect.objectContaining({ code: "SETTINGS_NOT_CONFIRMED" }),
    );
  });

  it("returns empty blockers when draft and confirmation are fully valid", () => {
    const draft = validDraft();
    const confirmation = validConfirmation(draft);
    const blockers = evaluateSubmission(draft, validCreator(), confirmation, "now", null, now, false);
    expect(blockers).toEqual([]);
  });
});
