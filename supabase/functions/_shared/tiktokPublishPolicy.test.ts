import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  creatorCapabilitiesFromTikTok,
  evaluateTikTokPublishPolicy,
  isPolicyViolationCode,
  policyViolationMessage,
  resolveReviewDurationSec,
  type PolicyViolationCode,
  type TikTokCreatorCapabilities,
  type TikTokPublishPolicyInput,
  type TikTokReviewSettings,
} from "./tiktokPublishPolicy.ts";

const validCreator: TikTokCreatorCapabilities = {
  privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
  commentDisabled: false,
  duetDisabled: false,
  stitchDisabled: false,
  maxVideoPostDurationSec: 600,
  postingBlocked: false,
};

const validSettings: TikTokReviewSettings = {
  privacy: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  disclose: false,
  yourBrand: false,
  brandedContent: false,
  aiGenerated: false,
};

const validInput: TikTokPublishPolicyInput = {
  caption: "Valid caption for TikTok video",
  settings: validSettings,
  mediaFileId: "11111111-1111-4111-8111-111111111111",
  durationSec: 60,
  creator: validCreator,
};

Deno.test("empty result for a fully valid input", () => {
  const violations = evaluateTikTokPublishPolicy(validInput);
  assertEquals(violations, []);
});

Deno.test("single-rule violation tests (table-driven)", () => {
  const cases: Array<{
    name: string;
    input: TikTokPublishPolicyInput;
    expectedCode: PolicyViolationCode;
    expectedMessage: string;
  }> = [
    {
      name: "POSTING_BLOCKED when creator posting is blocked",
      input: { ...validInput, creator: { ...validCreator, postingBlocked: true } },
      expectedCode: "POSTING_BLOCKED",
      expectedMessage: "TikTok is blocking new posts from this account.",
    },
    {
      name: "MEDIA_REQUIRED when mediaFileId is null",
      input: { ...validInput, mediaFileId: null },
      expectedCode: "MEDIA_REQUIRED",
      expectedMessage: "Add a video before publishing.",
    },
    {
      name: "MEDIA_REQUIRED when mediaFileId is empty",
      input: { ...validInput, mediaFileId: "" },
      expectedCode: "MEDIA_REQUIRED",
      expectedMessage: "Add a video before publishing.",
    },
    {
      name: "PRIVACY_REQUIRED when privacy is null",
      input: { ...validInput, settings: { ...validSettings, privacy: null } },
      expectedCode: "PRIVACY_REQUIRED",
      expectedMessage: "Choose who can view this post.",
    },
    {
      name: "PRIVACY_REQUIRED when privacy is empty",
      input: { ...validInput, settings: { ...validSettings, privacy: "" } },
      expectedCode: "PRIVACY_REQUIRED",
      expectedMessage: "Choose who can view this post.",
    },
    {
      name: "PRIVACY_NOT_OFFERED when privacy is not in creator options",
      input: { ...validInput, settings: { ...validSettings, privacy: "FOO_UNSUPPORTED" } },
      expectedCode: "PRIVACY_NOT_OFFERED",
      expectedMessage: "This privacy setting isn't available for this account.",
    },
    {
      name: "COMMENT_NOT_ALLOWED when comments enabled but creator disabled them",
      input: {
        ...validInput,
        settings: { ...validSettings, allowComment: true },
        creator: { ...validCreator, commentDisabled: true },
      },
      expectedCode: "COMMENT_NOT_ALLOWED",
      expectedMessage: "Comments can't be turned on for this account.",
    },
    {
      name: "DUET_NOT_ALLOWED when duet enabled but creator disabled it",
      input: {
        ...validInput,
        settings: { ...validSettings, allowDuet: true },
        creator: { ...validCreator, duetDisabled: true },
      },
      expectedCode: "DUET_NOT_ALLOWED",
      expectedMessage: "Duet can't be turned on for this account.",
    },
    {
      name: "STITCH_NOT_ALLOWED when stitch enabled but creator disabled it",
      input: {
        ...validInput,
        settings: { ...validSettings, allowStitch: true },
        creator: { ...validCreator, stitchDisabled: true },
      },
      expectedCode: "STITCH_NOT_ALLOWED",
      expectedMessage: "Stitch can't be turned on for this account.",
    },
    {
      name: "DISCLOSURE_INCOMPLETE when disclose is true without selecting yourBrand or brandedContent",
      input: {
        ...validInput,
        settings: {
          ...validSettings,
          disclose: true,
          yourBrand: false,
          brandedContent: false,
        },
      },
      expectedCode: "DISCLOSURE_INCOMPLETE",
      expectedMessage: "Indicate whether this promotes you, a third party, or both.",
    },
    {
      name: "BRANDED_CONTENT_PRIVATE when branded content paired with SELF_ONLY",
      input: {
        ...validInput,
        settings: {
          ...validSettings,
          privacy: "SELF_ONLY",
          disclose: true,
          yourBrand: false,
          brandedContent: true,
        },
      },
      expectedCode: "BRANDED_CONTENT_PRIVATE",
      expectedMessage: "Branded content can't be set to Only me.",
    },
  ];

  for (const c of cases) {
    const violations = evaluateTikTokPublishPolicy(c.input);
    assertEquals(
      violations,
      [{ code: c.expectedCode, message: c.expectedMessage }],
      `Mismatch for case: ${c.name}`,
    );
  }
});

Deno.test("brandedContent + SELF_ONLY + disclose=false → no violation", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: {
      ...validSettings,
      privacy: "SELF_ONLY",
      disclose: false,
      yourBrand: false,
      brandedContent: true,
    },
  });
  assertEquals(violations, []);
});

Deno.test("violation code: CAPTION_TOO_LONG at 2201 UTF-16 units but not at 2200 using surrogate pairs", () => {
  const surrogateEmoji = "🎉";
  const caption2200 = surrogateEmoji.repeat(1100);

  const violationsAtLimit = evaluateTikTokPublishPolicy({
    ...validInput,
    caption: caption2200,
  });
  assertEquals(violationsAtLimit, []);

  const caption2201 = caption2200 + "x";
  const violationsOverLimit = evaluateTikTokPublishPolicy({
    ...validInput,
    caption: caption2201,
  });
  assertEquals(violationsOverLimit, [
    {
      code: "CAPTION_TOO_LONG",
      message: "Caption must be 2,200 characters or fewer.",
    },
  ]);
});

Deno.test("violation code: DURATION_UNKNOWN for null, NaN, 0, or negative duration", () => {
  for (const invalidDuration of [null, NaN, 0, -1, -0.5]) {
    const violations = evaluateTikTokPublishPolicy({
      ...validInput,
      durationSec: invalidDuration,
    });
    assertEquals(violations, [
      {
        code: "DURATION_UNKNOWN",
        message: "Video length is required before publishing.",
      },
    ]);
  }
});

Deno.test("violation code: DURATION_EXCEEDED at max+1 but not at max", () => {
  const max = validCreator.maxVideoPostDurationSec; // 600

  const violationsAtMax = evaluateTikTokPublishPolicy({
    ...validInput,
    durationSec: max,
  });
  assertEquals(violationsAtMax, []);

  const violationsOverMax = evaluateTikTokPublishPolicy({
    ...validInput,
    durationSec: max + 1,
  });
  assertEquals(violationsOverMax, [
    {
      code: "DURATION_EXCEEDED",
      message: "This video is longer than this account can post.",
    },
  ]);
});

Deno.test("deterministic violation ordering when multiple rules fail simultaneously", () => {
  const multiFailureInput: TikTokPublishPolicyInput = {
    caption: "A".repeat(2201),
    settings: {
      privacy: null,
      allowComment: true,
      allowDuet: true,
      allowStitch: true,
      disclose: true,
      yourBrand: false,
      brandedContent: false,
      aiGenerated: false,
    },
    mediaFileId: null,
    durationSec: null,
    creator: {
      ...validCreator,
      postingBlocked: true,
      commentDisabled: true,
      duetDisabled: true,
      stitchDisabled: true,
    },
  };

  const violations = evaluateTikTokPublishPolicy(multiFailureInput);
  const codes = violations.map((v) => v.code);
  assertEquals(codes, [
    "POSTING_BLOCKED",
    "MEDIA_REQUIRED",
    "PRIVACY_REQUIRED",
    "COMMENT_NOT_ALLOWED",
    "DUET_NOT_ALLOWED",
    "STITCH_NOT_ALLOWED",
    "DISCLOSURE_INCOMPLETE",
    "CAPTION_TOO_LONG",
  ]);
});

Deno.test("no duration violations are reported when mediaFileId is missing", () => {
  for (const duration of [null, NaN, 0, -10, 999999]) {
    const violations = evaluateTikTokPublishPolicy({
      ...validInput,
      mediaFileId: null,
      durationSec: duration,
    });
    assertEquals(violations, [
      {
        code: "MEDIA_REQUIRED",
        message: "Add a video before publishing.",
      },
    ]);
  }
});

Deno.test("creatorCapabilitiesFromTikTok returns null for missing or invalid privacy list", () => {
  assertEquals(creatorCapabilitiesFromTikTok(null), null);
  assertEquals(creatorCapabilitiesFromTikTok("not a record"), null);
  assertEquals(creatorCapabilitiesFromTikTok({}), null);
  assertEquals(
    creatorCapabilitiesFromTikTok({
      max_video_post_duration_sec: 600,
    }),
    null,
  );
  assertEquals(
    creatorCapabilitiesFromTikTok({
      privacy_level_options: "PUBLIC_TO_EVERYONE",
      max_video_post_duration_sec: 600,
    }),
    null,
  );
  assertEquals(
    creatorCapabilitiesFromTikTok({
      privacy_level_options: [123],
      max_video_post_duration_sec: 600,
    }),
    null,
  );
});

Deno.test("creatorCapabilitiesFromTikTok returns null for non-positive or invalid duration", () => {
  const validPrivacy = ["PUBLIC_TO_EVERYONE"];
  for (const invalidMax of [0, -1, NaN, Infinity, null, "600", undefined]) {
    assertEquals(
      creatorCapabilitiesFromTikTok({
        privacy_level_options: validPrivacy,
        max_video_post_duration_sec: invalidMax,
      }),
      null,
    );
  }
});

Deno.test("creatorCapabilitiesFromTikTok strictly maps boolean flags and sets postingBlocked to false", () => {
  const raw = {
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    max_video_post_duration_sec: 180,
    comment_disabled: true,
    duet_disabled: false,
    stitch_disabled: "true", // non-boolean
  };

  const capabilities = creatorCapabilitiesFromTikTok(raw);
  assertEquals(capabilities, {
    privacyLevelOptions: ["PUBLIC_TO_EVERYONE", "SELF_ONLY"],
    commentDisabled: true,
    duetDisabled: false,
    stitchDisabled: false,
    maxVideoPostDurationSec: 180,
    postingBlocked: false,
  });
});

Deno.test("resolveReviewDurationSec: media metadata duration wins when finite positive; else fallback; numeric strings rejected; null when neither", () => {
  // Media metadata duration wins when finite positive
  assertEquals(resolveReviewDurationSec({ duration: 45 }, 60), 45);
  assertEquals(resolveReviewDurationSec({ duration: 12.5 }, 30), 12.5);
  assertEquals(resolveReviewDurationSec({ duration: 45 }, null), 45);
  assertEquals(resolveReviewDurationSec({ duration: 45 }, undefined), 45);

  // When media metadata duration is invalid/non-positive, fallback wins if finite positive
  assertEquals(resolveReviewDurationSec({ duration: 0 }, 60), 60);
  assertEquals(resolveReviewDurationSec({ duration: -10 }, 60), 60);
  assertEquals(resolveReviewDurationSec({ duration: NaN }, 60), 60);
  assertEquals(resolveReviewDurationSec({ duration: Infinity }, 60), 60);
  assertEquals(resolveReviewDurationSec({ duration: null }, 60), 60);
  assertEquals(resolveReviewDurationSec({}, 60), 60);
  assertEquals(resolveReviewDurationSec(null, 60), 60);
  assertEquals(resolveReviewDurationSec("not-an-object", 60), 60);

  // Numeric strings rejected for both media metadata and fallback
  assertEquals(resolveReviewDurationSec({ duration: "45" }, 60), 60);
  assertEquals(resolveReviewDurationSec({ duration: "45" }, "60"), null);
  assertEquals(resolveReviewDurationSec(null, "60"), null);
  assertEquals(resolveReviewDurationSec({ duration: 45 }, "60"), 45);

  // Null when neither is finite positive
  assertEquals(resolveReviewDurationSec(null, null), null);
  assertEquals(resolveReviewDurationSec({}, undefined), null);
  assertEquals(resolveReviewDurationSec({ duration: 0 }, 0), null);
  assertEquals(resolveReviewDurationSec({ duration: -5 }, -10), null);
  assertEquals(resolveReviewDurationSec({ duration: NaN }, NaN), null);
  assertEquals(resolveReviewDurationSec({ duration: Infinity }, -1), null);
});

Deno.test("isPolicyViolationCode returns false for non-policy codes and object prototype properties", () => {
  const nonPolicyCodes = [
    "toString",
    "constructor",
    "__proto__",
    "CREATOR_INFO_UNAVAILABLE",
    "SUBMISSION_READ_FAILED",
    "SUBMISSION_NOT_FOUND",
    "MEDIA_READ_FAILED",
    "ALREADY_DISPATCHED",
    "SNAPSHOT_MISMATCH",
    "TOKEN_INVALID",
    "UNKNOWN_CODE",
    "",
  ];
  for (const nonCode of nonPolicyCodes) {
    assertEquals(isPolicyViolationCode(nonCode), false, `Expected ${nonCode} to NOT be a policy violation code`);
  }
});
