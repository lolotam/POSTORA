import { describe, expect, it, test } from "vitest";
import {
  canTransition,
  consentKey,
  musicConsentText,
  privacyLabel,
  reviewBlockers,
  sanitizeSettingsForCreator,
  type ReviewBlockerCode,
  type ReviewBlockerInput,
  type ReviewTransition,
} from "./reviewRules";
import type { CreatorInfo, ReviewState, TikTokSettings } from "./types";

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

function emptySettings(): TikTokSettings {
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

function validBlockerInput(): ReviewBlockerInput {
  return {
    caption: "Valid caption",
    settings: {
      privacy: "PUBLIC_TO_EVERYONE",
      allowComment: true,
      allowDuet: true,
      allowStitch: true,
      disclose: false,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    },
    mediaFileId: "media-file-1",
    durationSec: 45,
    creator: validCreator(),
    settingsConfirmed: true,
    consentGranted: true,
    mode: "now",
    scheduledAt: null,
  };
}

describe("reviewRules - reviewBlockers", () => {
  it("returns empty blockers when all requirements are satisfied", () => {
    const input = validBlockerInput();
    expect(reviewBlockers(input)).toEqual([]);
  });

  it("does not report BRANDED_CONTENT_PRIVATE when disclose is false even if brandedContent is true under SELF_ONLY", () => {
    const input: ReviewBlockerInput = {
      ...validBlockerInput(),
      settings: {
        ...validBlockerInput().settings,
        privacy: "SELF_ONLY",
        disclose: false,
        brandedContent: true,
      },
    };
    const blockers = reviewBlockers(input);
    expect(blockers).not.toContainEqual(
      expect.objectContaining({ code: "BRANDED_CONTENT_PRIVATE" }),
    );
  });

  const singleBlockerCases: Array<[string, Partial<ReviewBlockerInput>, ReviewBlockerCode | null]> = [
    ["missing mediaFileId", { mediaFileId: null }, "MEDIA_REQUIRED"],
    ["missing privacy setting", { settings: { ...validBlockerInput().settings, privacy: null } }, "PRIVACY_REQUIRED"],
    ["privacy not offered by creator", { settings: { ...validBlockerInput().settings, privacy: "FOLLOWER_OF_CREATOR" } }, "PRIVACY_NOT_OFFERED"],
    ["duet enabled while creator disabled it", { creator: { ...validCreator(), duetDisabled: true }, settings: { ...validBlockerInput().settings, allowDuet: true } }, "DUET_NOT_ALLOWED"],
    ["comment enabled while creator disabled it", { creator: { ...validCreator(), commentDisabled: true }, settings: { ...validBlockerInput().settings, allowComment: true } }, "COMMENT_NOT_ALLOWED"],
    ["stitch enabled while creator disabled it", { creator: { ...validCreator(), stitchDisabled: true }, settings: { ...validBlockerInput().settings, allowStitch: true } }, "STITCH_NOT_ALLOWED"],
    ["posting blocked with custom reason", { creator: { ...validCreator(), postingBlocked: true, postingBlockedReason: "Spam risk active user cap" } }, "POSTING_BLOCKED"],
    ["posting blocked with default reason", { creator: { ...validCreator(), postingBlocked: true, postingBlockedReason: null } }, "POSTING_BLOCKED"],
    ["disclosure enabled without yourBrand or brandedContent", { settings: { ...validBlockerInput().settings, disclose: true, yourBrand: false, brandedContent: false } }, "DISCLOSURE_INCOMPLETE"],
    ["branded content marked under SELF_ONLY privacy", { settings: { ...validBlockerInput().settings, privacy: "SELF_ONLY", disclose: true, brandedContent: true } }, "BRANDED_CONTENT_PRIVATE"],
    ["caption at exactly max 2200 characters produces no blocker (boundary)", { caption: "a".repeat(2200) }, null],
    ["caption at 2201 characters exceeds max (boundary)", { caption: "a".repeat(2201) }, "CAPTION_TOO_LONG"],
    ["duration unknown when media present but durationSec null", { durationSec: null }, "DURATION_UNKNOWN"],
    ["duration exactly equal to creator max produces no blocker (boundary)", { durationSec: 60, creator: { ...validCreator(), maxVideoPostDurationSec: 60 } }, null],
    ["duration exceeds creator max", { durationSec: 61, creator: { ...validCreator(), maxVideoPostDurationSec: 60 } }, "DURATION_EXCEEDED"],
    ["creator info unavailable", { creator: null }, "CREATOR_INFO_UNAVAILABLE"],
    ["settings not confirmed", { settingsConfirmed: false }, "SETTINGS_NOT_CONFIRMED"],
    ["consent not granted", { consentGranted: false }, "CONSENT_REQUIRED"],
    ["scheduled mode with null scheduledAt", { mode: "scheduled", scheduledAt: null }, "SCHEDULE_TIME_REQUIRED"],
  ];

  test.each(singleBlockerCases)(
    "single blocker evaluation: %s",
    (_name, overrides, expectedCode) => {
      const input: ReviewBlockerInput = { ...validBlockerInput(), ...overrides };
      const blockers = reviewBlockers(input);
      if (expectedCode === null) {
        expect(blockers).toEqual([]);
      } else {
        expect(blockers.map((b) => b.code)).toContain(expectedCode);
      }
    },
  );

  it("reports POSTING_BLOCKED with custom message when provided or default when null", () => {
    const custom = reviewBlockers({
      ...validBlockerInput(),
      creator: { ...validCreator(), postingBlocked: true, postingBlockedReason: "Spam risk active user cap" },
    });
    expect(custom).toContainEqual({
      code: "POSTING_BLOCKED",
      message: "Spam risk active user cap",
    });

    const fallback = reviewBlockers({
      ...validBlockerInput(),
      creator: { ...validCreator(), postingBlocked: true, postingBlockedReason: null },
    });
    expect(fallback).toContainEqual({
      code: "POSTING_BLOCKED",
      message: "TikTok is not allowing posts from this account right now.",
    });
  });

  it("preserves the defined order of blockers when multiple rules are violated", () => {
    const input: ReviewBlockerInput = {
      caption: "a".repeat(2201),
      settings: emptySettings(),
      mediaFileId: null,
      durationSec: null,
      creator: { ...validCreator(), postingBlocked: true, postingBlockedReason: "Blocked by TikTok" },
      settingsConfirmed: false,
      consentGranted: false,
      mode: "scheduled",
      scheduledAt: null,
    };
    const blockers = reviewBlockers(input);
    const codes = blockers.map((b) => b.code);
    expect(codes).toEqual([
      "SCHEDULE_TIME_REQUIRED",
      "POSTING_BLOCKED",
      "MEDIA_REQUIRED",
      "PRIVACY_REQUIRED",
      "CAPTION_TOO_LONG",
      "SETTINGS_NOT_CONFIRMED",
      "CONSENT_REQUIRED",
    ]);
    expect(blockers[0]?.code).toBe("SCHEDULE_TIME_REQUIRED");
  });
});

describe("reviewRules - consentKey", () => {
  const baseSettings: TikTokSettings = {
    privacy: "PUBLIC_TO_EVERYONE",
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  };

  const baseKey = consentKey("draft-1", "acc-1", 1, "media-1", baseSettings);

  it("is stable across multiple calls with identical arguments", () => {
    const k1 = consentKey("draft-1", "acc-1", 1, "media-1", baseSettings);
    const k2 = consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings });
    expect(k1).toBe(k2);
  });

  test.each([
    ["draftId", consentKey("draft-2", "acc-1", 1, "media-1", baseSettings)],
    ["accountId", consentKey("draft-1", "acc-2", 1, "media-1", baseSettings)],
    ["revision", consentKey("draft-1", "acc-1", 2, "media-1", baseSettings)],
    ["mediaFileId", consentKey("draft-1", "acc-1", 1, "media-2", baseSettings)],
    ["mediaFileId null", consentKey("draft-1", "acc-1", 1, null, baseSettings)],
    ["settings privacy", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, privacy: "SELF_ONLY" })],
    ["settings allowComment", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, allowComment: true })],
    ["settings allowDuet", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, allowDuet: true })],
    ["settings allowStitch", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, allowStitch: true })],
    ["settings disclose", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, disclose: true })],
    ["settings yourBrand", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, yourBrand: true })],
    ["settings brandedContent", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, brandedContent: true })],
    ["settings aiGenerated", consentKey("draft-1", "acc-1", 1, "media-1", { ...baseSettings, aiGenerated: true })],
  ])("changes when %s changes", (_param, changedKey) => {
    expect(changedKey).not.toBe(baseKey);
  });

  it("takes no publish mode or time, so choosing Now or a schedule cannot invalidate it", () => {
    expect(consentKey.length).toBe(5);
  });
});

describe("reviewRules - sanitizeSettingsForCreator", () => {
  it("clears a privacy setting not offered by the creator", () => {
    const creator: CreatorInfo = {
      ...validCreator(),
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    };
    const settings: TikTokSettings = {
      ...emptySettings(),
      privacy: "FOLLOWER_OF_CREATOR",
    };
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized.privacy).toBeNull();
  });

  it("keeps a privacy setting that is offered by the creator", () => {
    const creator = validCreator();
    const settings: TikTokSettings = {
      ...emptySettings(),
      privacy: "PUBLIC_TO_EVERYONE",
    };
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized.privacy).toBe("PUBLIC_TO_EVERYONE");
  });

  it("switches off creator-disabled interactions", () => {
    const creator: CreatorInfo = {
      ...validCreator(),
      commentDisabled: true,
      duetDisabled: true,
      stitchDisabled: true,
    };
    const settings: TikTokSettings = {
      ...emptySettings(),
      allowComment: true,
      allowDuet: true,
      allowStitch: true,
    };
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized.allowComment).toBe(false);
    expect(sanitized.allowDuet).toBe(false);
    expect(sanitized.allowStitch).toBe(false);
  });

  it("clears brandedContent under SELF_ONLY when disclose is true", () => {
    const creator = validCreator();
    const settings: TikTokSettings = {
      ...emptySettings(),
      privacy: "SELF_ONLY",
      disclose: true,
      brandedContent: true,
    };
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized.brandedContent).toBe(false);
  });

  it("does not clear brandedContent when disclose is false even under SELF_ONLY", () => {
    const creator = validCreator();
    const settings: TikTokSettings = {
      ...emptySettings(),
      privacy: "SELF_ONLY",
      disclose: false,
      brandedContent: true,
    };
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized.brandedContent).toBe(true);
  });

  it("never switches anything on when creator permits it but user left it off", () => {
    const creator: CreatorInfo = {
      ...validCreator(),
      commentDisabled: false,
      duetDisabled: false,
      stitchDisabled: false,
      privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    };
    const settings = emptySettings();
    const sanitized = sanitizeSettingsForCreator(settings, creator);
    expect(sanitized).toEqual(emptySettings());
  });
});

describe("reviewRules - musicConsentText", () => {
  it("returns plain wording when disclosure or brandedContent is off", () => {
    expect(musicConsentText(emptySettings())).toBe(
      "By posting, you agree to TikTok's Music Usage Confirmation.",
    );

    const yourBrandOnly: TikTokSettings = {
      ...emptySettings(),
      disclose: true,
      yourBrand: true,
      brandedContent: false,
    };
    expect(musicConsentText(yourBrandOnly)).toBe(
      "By posting, you agree to TikTok's Music Usage Confirmation.",
    );

    const brandedWithoutDisclose: TikTokSettings = {
      ...emptySettings(),
      disclose: false,
      brandedContent: true,
    };
    expect(musicConsentText(brandedWithoutDisclose)).toBe(
      "By posting, you agree to TikTok's Music Usage Confirmation.",
    );
  });

  it("returns branded wording when disclose and brandedContent are both true", () => {
    const branded: TikTokSettings = {
      ...emptySettings(),
      disclose: true,
      brandedContent: true,
    };
    expect(musicConsentText(branded)).toBe(
      "By posting, you agree to TikTok's Branded Content Policy and Music Usage Confirmation.",
    );
  });
});

describe("reviewRules - canTransition", () => {
  test.each([
    ["pending_review", "reject", true],
    ["pending_review", "archive", true],
    ["pending_review", "restore", false],
    ["pending_review", "edit", true],
    ["pending_review", "save", true],
    ["pending_review", "submit", true],

    ["rejected", "reject", false],
    ["rejected", "archive", true],
    ["rejected", "restore", false],
    ["rejected", "edit", true],
    ["rejected", "save", true],
    ["rejected", "submit", false],

    ["archived", "reject", false],
    ["archived", "archive", false],
    ["archived", "restore", true],
    ["archived", "edit", false],
    ["archived", "save", false],
    ["archived", "submit", false],

    ["submitted", "reject", false],
    ["submitted", "archive", false],
    ["submitted", "restore", false],
    ["submitted", "edit", false],
    ["submitted", "save", false],
    ["submitted", "submit", false],
  ] as const)(
    "canTransition(%s, %s) is %s",
    (state: ReviewState, action: ReviewTransition, expected: boolean) => {
      expect(canTransition(state, action)).toBe(expected);
    },
  );
});

describe("reviewRules - privacyLabel", () => {
  it("translates known privacy levels", () => {
    expect(privacyLabel("PUBLIC_TO_EVERYONE")).toBe("Everyone");
    expect(privacyLabel("MUTUAL_FOLLOW_FRIENDS")).toBe("Friends");
    expect(privacyLabel("FOLLOWER_OF_CREATOR")).toBe("Followers");
    expect(privacyLabel("SELF_ONLY")).toBe("Only me");
  });

  it("returns unknown level as-is", () => {
    expect(privacyLabel("CUSTOM_LEVEL")).toBe("CUSTOM_LEVEL");
  });
});
