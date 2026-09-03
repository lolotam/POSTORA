import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import { youtubeOptionsUnsupportedOnComposio } from "./youtubeComposioOptions.ts";

const unsupportedCases: Array<[string, unknown]> = [
  ["youtube_made_for_kids", true],
  ["youtube_notify_subscribers", false],
  ["youtube_allow_embedding", false],
  ["youtube_public_stats_viewable", false],
  ["youtube_contains_synthetic_media", true],
  ["youtube_has_paid_promotion", true],
  ["youtube_video_language", "en"],
  ["youtube_audio_language", "ar"],
  ["youtube_recording_date", "2026-09-03T00:00:00Z"],
  ["youtube_license", "creativeCommon"],
  ["youtube_allowed_countries", ["KW"]],
  ["youtube_blocked_countries", ["US"]],
  ["youtube_first_comment", "First"],
];

for (const [key, value] of unsupportedCases) {
  Deno.test(`Composio YouTube refuses ${key} only when its unsupported value is set`, () => {
    assertEquals(youtubeOptionsUnsupportedOnComposio({ [key]: value }), [key]);
  });
}

Deno.test("Composio YouTube accepts mapped metadata and harmless defaults", () => {
  assertEquals(
    youtubeOptionsUnsupportedOnComposio({
      youtube_title: "Title",
      youtube_description: "Description",
      youtube_tags: ["tag"],
      youtube_category: "22",
      youtube_visibility: "unlisted",
      youtube_thumbnail_url: "https://example.invalid/thumb.jpg",
      youtube_video_type: "short",
      youtube_made_for_kids: false,
      youtube_notify_subscribers: true,
      youtube_allow_embedding: true,
      youtube_public_stats_viewable: true,
      youtube_contains_synthetic_media: false,
      youtube_has_paid_promotion: false,
      youtube_video_language: "",
      youtube_audio_language: " ",
      youtube_recording_date: null,
      youtube_license: "youtube",
      youtube_allowed_countries: [],
      youtube_blocked_countries: null,
      youtube_first_comment: undefined,
    }),
    [],
  );
  assertEquals(youtubeOptionsUnsupportedOnComposio(null), []);
  assertEquals(youtubeOptionsUnsupportedOnComposio(undefined), []);
});

// The browser copy (src/lib) disables the same controls the server refuses;
// a key added to one side and not the other is a post that fails only at
// publish time.
Deno.test("the browser copy of the unsupported-key list matches the server's", async () => {
  const keyBlock = (source: string) =>
    source.match(/UNSUPPORTED_OPTION_KEYS = \[([\s\S]*?)\] as const/)![1]
      .split(",").map((k) => k.trim().replace(/"/g, "")).filter(Boolean);
  const server = await Deno.readTextFile(new URL("./youtubeComposioOptions.ts", import.meta.url));
  const browser = await Deno.readTextFile(
    new URL("../../../src/lib/youtubeComposioOptions.ts", import.meta.url),
  );
  assertEquals(keyBlock(browser), keyBlock(server));
});
