import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  creatorCapabilitiesFromTikTok,
  evaluateTikTokPublishPolicy,
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

Deno.test("violation code: POSTING_BLOCKED when creator posting is blocked", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    creator: { ...validCreator, postingBlocked: true },
  });
  assertEquals(violations, [
    {
      code: "POSTING_BLOCKED",
      message: "TikTok is blocking new posts from this account.",
    },
  ]);
});

Deno.test("violation code: MEDIA_REQUIRED when mediaFileId is null or empty", () => {
  const violationsNull = evaluateTikTokPublishPolicy({
    ...validInput,
    mediaFileId: null,
  });
  assertEquals(violationsNull, [
    {
      code: "MEDIA_REQUIRED",
      message: "Add a video before publishing.",
    },
  ]);

  const violationsEmpty = evaluateTikTokPublishPolicy({
    ...validInput,
    mediaFileId: "",
  });
  assertEquals(violationsEmpty, [
    {
      code: "MEDIA_REQUIRED",
      message: "Add a video before publishing.",
    },
  ]);
});

Deno.test("violation code: PRIVACY_REQUIRED when privacy is null or empty", () => {
  const violationsNull = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, privacy: null },
  });
  assertEquals(violationsNull, [
    {
      code: "PRIVACY_REQUIRED",
      message: "Choose who can view this post.",
    },
  ]);

  const violationsEmpty = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, privacy: "" },
  });
  assertEquals(violationsEmpty, [
    {
      code: "PRIVACY_REQUIRED",
      message: "Choose who can view this post.",
    },
  ]);
});

Deno.test("violation code: PRIVACY_NOT_OFFERED when privacy is not in creator options", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, privacy: "FOO_UNSUPPORTED" },
  });
  assertEquals(violations, [
    {
      code: "PRIVACY_NOT_OFFERED",
      message: "This privacy setting isn't available for this account.",
    },
  ]);
});

Deno.test("violation code: COMMENT_NOT_ALLOWED when comments are enabled but creator disabled them", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, allowComment: true },
    creator: { ...validCreator, commentDisabled: true },
  });
  assertEquals(violations, [
    {
      code: "COMMENT_NOT_ALLOWED",
      message: "Comments can't be turned on for this account.",
    },
  ]);
});

Deno.test("violation code: DUET_NOT_ALLOWED when duet is enabled but creator disabled it", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, allowDuet: true },
    creator: { ...validCreator, duetDisabled: true },
  });
  assertEquals(violations, [
    {
      code: "DUET_NOT_ALLOWED",
      message: "Duet can't be turned on for this account.",
    },
  ]);
});

Deno.test("violation code: STITCH_NOT_ALLOWED when stitch is enabled but creator disabled it", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: { ...validSettings, allowStitch: true },
    creator: { ...validCreator, stitchDisabled: true },
  });
  assertEquals(violations, [
    {
      code: "STITCH_NOT_ALLOWED",
      message: "Stitch can't be turned on for this account.",
    },
  ]);
});

Deno.test("violation code: DISCLOSURE_INCOMPLETE when disclose is true without selecting yourBrand or brandedContent", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: {
      ...validSettings,
      disclose: true,
      yourBrand: false,
      brandedContent: false,
    },
  });
  assertEquals(violations, [
    {
      code: "DISCLOSURE_INCOMPLETE",
      message: "Indicate whether this promotes you, a third party, or both.",
    },
  ]);
});

Deno.test("violation code: BRANDED_CONTENT_PRIVATE when branded content is paired with SELF_ONLY privacy", () => {
  const violations = evaluateTikTokPublishPolicy({
    ...validInput,
    settings: {
      ...validSettings,
      privacy: "SELF_ONLY",
      disclose: true,
      yourBrand: false,
      brandedContent: true,
    },
  });
  assertEquals(violations, [
    {
      code: "BRANDED_CONTENT_PRIVATE",
      message: "Branded content can't be set to Only me.",
    },
  ]);
});

Deno.test("violation code: CAPTION_TOO_LONG at 2201 UTF-16 units but not at 2200 using surrogate pairs", () => {
  // A surrogate pair emoji has .length === 2 in JavaScript (UTF-16 code units)
  const surrogateEmoji = "🎉";
  assertEquals(surrogateEmoji.length, 2);

  // 1100 surrogate pairs = 2200 UTF-16 code units (allowed maximum)
  const caption2200 = surrogateEmoji.repeat(1100);
  assertEquals(caption2200.length, 2200);

  const violationsAtLimit = evaluateTikTokPublishPolicy({
    ...validInput,
    caption: caption2200,
  });
  assertEquals(violationsAtLimit, []);

  // 2200 + 1 = 2201 UTF-16 code units (exceeds limit)
  const caption2201 = caption2200 + "x";
  assertEquals(caption2201.length, 2201);

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
