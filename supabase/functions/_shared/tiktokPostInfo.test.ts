import {
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTikTokPostInfo,
  tiktokPostSettingsFromReview,
  type TikTokPostSettings,
} from "./tiktokPostInfo.ts";

Deno.test("buildTikTokPostInfo mapping scenarios (table-driven)", () => {
  const cases = [
    {
      name: "core regression: maps privacy, disabled interactions, organic disclosure, and aigc correctly",
      caption: "Original caption for review",
      settings: {
        privacy: "SELF_ONLY",
        allowComment: false,
        allowDuet: false,
        allowStitch: false,
        disclose: true,
        yourBrand: true,
        brandedContent: false,
        aiGenerated: true,
      },
      expected: {
        title: "Original caption for review",
        privacy_level: "SELF_ONLY",
        disable_comment: true,
        disable_duet: true,
        disable_stitch: true,
        brand_organic_toggle: true,
        brand_content_toggle: false,
        is_aigc: true,
      },
    },
    {
      name: "disclose=false forces both brand toggles false even when yourBrand and brandedContent are true",
      caption: "Caption",
      settings: {
        privacy: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        disclose: false,
        yourBrand: true,
        brandedContent: true,
        aiGenerated: false,
      },
      expected: {
        title: "Caption",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
        brand_organic_toggle: false,
        brand_content_toggle: false,
        is_aigc: false,
      },
    },
    {
      name: "disclose=true with brandedContent=true and yourBrand=false maps content toggle accurately",
      caption: "Caption",
      settings: {
        privacy: "PUBLIC_TO_EVERYONE",
        allowComment: true,
        allowDuet: true,
        allowStitch: true,
        disclose: true,
        yourBrand: false,
        brandedContent: true,
        aiGenerated: false,
      },
      expected: {
        title: "Caption",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
        brand_organic_toggle: false,
        brand_content_toggle: true,
        is_aigc: false,
      },
    },
    {
      name: "every boolean key is explicitly present and false when toggles are enabled or flags are false",
      caption: "All false flags",
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
      expected: {
        title: "All false flags",
        privacy_level: "PUBLIC_TO_EVERYONE",
        disable_comment: false,
        disable_duet: false,
        disable_stitch: false,
        brand_organic_toggle: false,
        brand_content_toggle: false,
        is_aigc: false,
      },
    },
  ];

  for (const c of cases) {
    const actual = buildTikTokPostInfo(c.caption, c.settings);
    assertEquals(actual.title, c.expected.title, `Title mismatch for ${c.name}`);
    assertEquals(actual.privacy_level, c.expected.privacy_level, `privacy_level mismatch for ${c.name}`);
    assertEquals(actual.disable_comment, c.expected.disable_comment, `disable_comment mismatch for ${c.name}`);
    assertEquals(actual.disable_duet, c.expected.disable_duet, `disable_duet mismatch for ${c.name}`);
    assertEquals(actual.disable_stitch, c.expected.disable_stitch, `disable_stitch mismatch for ${c.name}`);
    assertEquals(actual.brand_organic_toggle, c.expected.brand_organic_toggle, `brand_organic_toggle mismatch for ${c.name}`);
    assertEquals(actual.brand_content_toggle, c.expected.brand_content_toggle, `brand_content_toggle mismatch for ${c.name}`);
    assertEquals(actual.is_aigc, c.expected.is_aigc, `is_aigc mismatch for ${c.name}`);
  }
});

Deno.test("caption longer than 2200 characters is not truncated by buildTikTokPostInfo", () => {
  const longCaption = "A".repeat(3000);
  const settings: TikTokPostSettings = {
    privacy: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  };
  const actual = buildTikTokPostInfo(longCaption, settings);
  assertEquals(actual.title.length, 3000);
  assertEquals(actual.title, longCaption);
});

Deno.test("buildTikTokPostInfo throws when privacy string is empty", () => {
  const settings: TikTokPostSettings = {
    privacy: "",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  };
  assertThrows(
    () => buildTikTokPostInfo("Caption", settings),
    Error,
    "TIKTOK_POST_INFO_PRIVACY_REQUIRED",
  );
});

Deno.test("tiktokPostSettingsFromReview returns null without a valid non-empty privacy string", () => {
  assertEquals(tiktokPostSettingsFromReview({}), null);
  assertEquals(tiktokPostSettingsFromReview({ privacy: null }), null);
  assertEquals(tiktokPostSettingsFromReview({ privacy: "" }), null);
  assertEquals(tiktokPostSettingsFromReview({ privacy: 123 }), null);
  assertEquals(tiktokPostSettingsFromReview({ privacy: undefined }), null);
  assertEquals(tiktokPostSettingsFromReview({ privacy: false }), null);
  assertEquals(tiktokPostSettingsFromReview(null), null);
  assertEquals(tiktokPostSettingsFromReview("not an object"), null);
  assertEquals(tiktokPostSettingsFromReview([1, 2, 3]), null);
});

Deno.test("tiktokPostSettingsFromReview treats non-true values as false", () => {
  const settings = {
    privacy: "SELF_ONLY",
    allowComment: "true",
    allowDuet: 1,
    allowStitch: "1",
    disclose: {},
    yourBrand: "yes",
    brandedContent: [true],
    aiGenerated: "TRUE",
  };
  const actual = tiktokPostSettingsFromReview(settings);
  assertEquals(actual, {
    privacy: "SELF_ONLY",
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: false,
    yourBrand: false,
    brandedContent: false,
    aiGenerated: false,
  });
});

Deno.test("tiktokPostSettingsFromReview extracts boolean flags when strictly true", () => {
  const settings = {
    privacy: "MUTUAL_FOLLOW_FRIENDS",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: true,
    yourBrand: true,
    brandedContent: true,
    aiGenerated: true,
  };
  const actual = tiktokPostSettingsFromReview(settings);
  assertEquals(actual, {
    privacy: "MUTUAL_FOLLOW_FRIENDS",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: true,
    yourBrand: true,
    brandedContent: true,
    aiGenerated: true,
  });
});
