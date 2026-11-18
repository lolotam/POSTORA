import {
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  resolveYoutubePublishOptions,
  youtubePrivacyOrDefault,
  YOUTUBE_PRIVACY_VALUES,
} from "./youtubePublishOptions.ts";

Deno.test("a legacy alias is used when the canonical field is absent", () => {
  const resolved = resolveYoutubePublishOptions({
    youtube_category_id: "10",
    youtube_embeddable: false,
  });

  assertEquals(resolved.options.youtube_category, "10");
  assertEquals(resolved.options.youtube_allow_embedding, false);
  assertEquals(resolved.conflictingAliases, []);
});

Deno.test("the canonical field wins over its legacy alias", () => {
  const resolved = resolveYoutubePublishOptions({
    youtube_privacy: "unlisted",
    youtube_privacy_status: "public",
    youtube_category: "22",
    youtube_category_id: "10",
    youtube_allow_embedding: true,
    youtube_embeddable: false,
  });

  assertEquals(resolved.options.youtube_privacy, "unlisted");
  assertEquals(resolved.options.youtube_category, "22");
  assertEquals(resolved.options.youtube_allow_embedding, true);
});

Deno.test("a legacy privacy field is reported even with a canonical value", () => {
  const resolved = resolveYoutubePublishOptions({
    youtube_privacy: "unlisted",
    youtube_privacy_status: "public",
  });

  assertEquals(resolved.options.youtube_privacy, "unlisted");
  assertEquals(resolved.ignoredPrivacyFields, ["youtube_privacy_status"]);
});

Deno.test("legacy privacy from documentation and n8n cannot make a video public", () => {
  const resolved = resolveYoutubePublishOptions({
    youtube_privacy_status: "unlisted",
    youtube_visibility: "public",
  });
  assertEquals(youtubePrivacyOrDefault(resolved.options.youtube_privacy), "private");
  assertEquals(resolved.ignoredPrivacyFields, ["youtube_privacy_status", "youtube_visibility"]);
});

Deno.test("an absent option stays absent", () => {
  const resolved = resolveYoutubePublishOptions({});

  assertEquals(resolved.options, {});
  assertEquals(resolved.conflictingAliases, []);
});

Deno.test("a missing request resolves to no options at all", () => {
  assertEquals(resolveYoutubePublishOptions(null).options, {});
  assertEquals(resolveYoutubePublishOptions(undefined).options, {});
});

Deno.test("privacy defaults to private rather than to the provider default", () => {
  assertEquals(youtubePrivacyOrDefault(undefined), "private");
  assertEquals(youtubePrivacyOrDefault(null), "private");
  assertEquals(youtubePrivacyOrDefault(""), "private");
  assertEquals(youtubePrivacyOrDefault("everyone"), "private");
});

Deno.test("every accepted privacy status survives normalisation", () => {
  for (const status of YOUTUBE_PRIVACY_VALUES) {
    assertEquals(youtubePrivacyOrDefault(status), status);
  }
});
