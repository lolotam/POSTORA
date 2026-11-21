import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  assertComposioYoutubeDeclarations,
  assertNativeYoutubeDeclarations,
  missingYoutubeDeclarations,
  youtubeUploadPrivacy,
  YoutubeComposioDispatchUnavailableError,
  YoutubeDeclarationRequiredError,
} from "./youtubePublishSafety.ts";

Deno.test("an untouched declaration is not a declaration", () => {
  assertEquals(missingYoutubeDeclarations({}), [
    "youtube_made_for_kids",
    "youtube_contains_synthetic_media",
  ]);
  assertEquals(missingYoutubeDeclarations({ youtube_made_for_kids: false }), [
    "youtube_contains_synthetic_media",
  ]);
  assertEquals(missingYoutubeDeclarations({ youtube_made_for_kids: "false" }), [
    "youtube_made_for_kids",
    "youtube_contains_synthetic_media",
  ]);
});

Deno.test("an explicit No survives as a declaration", () => {
  const metadata = {
    youtube_made_for_kids: false,
    youtube_contains_synthetic_media: false,
  };
  assertEquals(missingYoutubeDeclarations(metadata), []);
});

Deno.test("uploads without visibility are private on both providers", () => {
  assertEquals(youtubeUploadPrivacy({}), "private");
  assertEquals(youtubeUploadPrivacy({ youtube_visibility: "everyone" }), "private");
  for (const status of ["public", "unlisted", "private"] as const) {
    assertEquals(youtubeUploadPrivacy({ youtube_visibility: status }), status);
  }
});

Deno.test("native dispatch refuses missing declarations and accepts explicit No", () => {
  assertThrows(
    () => assertNativeYoutubeDeclarations({}),
    YoutubeDeclarationRequiredError,
  );
  assertThrows(
    () => assertNativeYoutubeDeclarations({ youtube_made_for_kids: false }),
    YoutubeDeclarationRequiredError,
  );
  assertNativeYoutubeDeclarations({
    youtube_made_for_kids: false,
    youtube_contains_synthetic_media: false,
  });
});

Deno.test("managed dispatch is refused for every post, including explicit No/No", () => {
  for (const metadata of [
    {},
    { youtube_made_for_kids: true, youtube_contains_synthetic_media: false },
    { youtube_made_for_kids: false, youtube_contains_synthetic_media: false },
  ]) {
    const refusal = assertThrows(
      () => assertComposioYoutubeDeclarations(metadata),
      YoutubeComposioDispatchUnavailableError,
    );
    assertEquals(refusal.code, "youtube_composio_dispatch_unavailable");
  }
  assert(
    new YoutubeDeclarationRequiredError(["youtube_made_for_kids"]).code ===
      "youtube_declaration_required",
  );
});
