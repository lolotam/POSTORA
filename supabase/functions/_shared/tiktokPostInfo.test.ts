import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  buildTikTokPostInfo,
  tiktokPostSettingsFromMetadata,
  type TikTokPostSettings,
} from "./tiktokPostInfo.ts";

Deno.test("core regression: maps privacy, disabled interactions, organic disclosure, and aigc correctly", () => {
  const settings: TikTokPostSettings = {
    privacy: "SELF_ONLY",
    allowComment: false,
    allowDuet: false,
    allowStitch: false,
    disclose: true,
    yourBrand: true,
    brandedContent: false,
    aiGenerated: true,
  };
  const caption = "Original caption for review";
  const actual = buildTikTokPostInfo(caption, settings);
  assertEquals(actual.title, caption);
  assertEquals(actual.privacy_level, "SELF_ONLY");
  assertEquals(actual.brand_organic_toggle, true);
  assertEquals(actual.brand_content_toggle, false);
  assertEquals(actual.disable_comment, true);
  assertEquals(actual.disable_duet, true);
  assertEquals(actual.disable_stitch, true);
  assertEquals(actual.is_aigc, true);
});

Deno.test("disclose=false forces both brand toggles false even when yourBrand and brandedContent are true", () => {
  const settings: TikTokPostSettings = {
    privacy: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: false,
    yourBrand: true,
    brandedContent: true,
    aiGenerated: false,
  };
  const actual = buildTikTokPostInfo("Caption", settings);
  assertEquals(actual.brand_organic_toggle, false);
  assertEquals(actual.brand_content_toggle, false);
});

Deno.test("disclose=true with brandedContent=true and yourBrand=false maps content toggle accurately", () => {
  const settings: TikTokPostSettings = {
    privacy: "PUBLIC_TO_EVERYONE",
    allowComment: true,
    allowDuet: true,
    allowStitch: true,
    disclose: true,
    yourBrand: false,
    brandedContent: true,
    aiGenerated: false,
  };
  const actual = buildTikTokPostInfo("Caption", settings);
  assertEquals(actual.brand_organic_toggle, false);
  assertEquals(actual.brand_content_toggle, true);
});

Deno.test("every boolean key is explicitly present and false when toggles are enabled or flags are false", () => {
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
  const actual = buildTikTokPostInfo("All false flags", settings);
  assertEquals(actual.disable_comment, false);
  assertEquals(actual.disable_duet, false);
  assertEquals(actual.disable_stitch, false);
  assertEquals(actual.brand_organic_toggle, false);
  assertEquals(actual.brand_content_toggle, false);
  assertEquals(actual.is_aigc, false);

  const keys = Object.keys(actual);
  assert(keys.includes("disable_comment"));
  assert(keys.includes("disable_duet"));
  assert(keys.includes("disable_stitch"));
  assert(keys.includes("brand_organic_toggle"));
  assert(keys.includes("brand_content_toggle"));
  assert(keys.includes("is_aigc"));
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

Deno.test("tiktokPostSettingsFromMetadata returns null without a valid non-empty privacy string", () => {
  assertEquals(tiktokPostSettingsFromMetadata({}), null);
  assertEquals(tiktokPostSettingsFromMetadata({ tiktok_privacy_level: null }), null);
  assertEquals(tiktokPostSettingsFromMetadata({ tiktok_privacy_level: "" }), null);
  assertEquals(tiktokPostSettingsFromMetadata({ tiktok_privacy_level: 123 }), null);
  assertEquals(tiktokPostSettingsFromMetadata({ tiktok_privacy_level: undefined }), null);
  assertEquals(tiktokPostSettingsFromMetadata({ tiktok_privacy_level: false }), null);
});

Deno.test("tiktokPostSettingsFromMetadata treats non-true values as false", () => {
  const metadata = {
    tiktok_privacy_level: "SELF_ONLY",
    tiktok_allow_comment: "true",
    tiktok_allow_duet: 1,
    tiktok_allow_stitch: "1",
    tiktok_disclose_content: {},
    tiktok_your_brand: "yes",
    tiktok_branded_content: [true],
    tiktok_ai_generated: "TRUE",
  };
  const actual = tiktokPostSettingsFromMetadata(metadata);
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

Deno.test("tiktokPostSettingsFromMetadata extracts boolean flags when strictly true", () => {
  const metadata = {
    tiktok_privacy_level: "MUTUAL_FOLLOW_FRIENDS",
    tiktok_allow_comment: true,
    tiktok_allow_duet: true,
    tiktok_allow_stitch: true,
    tiktok_disclose_content: true,
    tiktok_your_brand: true,
    tiktok_branded_content: true,
    tiktok_ai_generated: true,
  };
  const actual = tiktokPostSettingsFromMetadata(metadata);
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
