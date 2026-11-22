import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  assertComposioYoutubeDeclarations,
  assertNativeYoutubeDeclarations,
  buildYoutubeDeclarationProof,
  missingYoutubeDeclarations,
  YOUTUBE_DECLARATION_PROOF_VERSION,
  youtubeUploadPrivacy,
  YoutubeComposioDispatchUnavailableError,
  YoutubeDeclarationRequiredError,
} from "./youtubePublishSafety.ts";

const explicitNo = {
  youtube_made_for_kids: false,
  youtube_contains_synthetic_media: false,
};

Deno.test("an untouched declaration is not a declaration", () => {
  assertEquals(missingYoutubeDeclarations({}), [
    "youtube_made_for_kids",
    "youtube_contains_synthetic_media",
  ]);
  assertEquals(missingYoutubeDeclarations({ youtube_made_for_kids: "false" }), [
    "youtube_made_for_kids",
    "youtube_contains_synthetic_media",
  ]);
});

Deno.test("a legacy stored false without a versioned proof is not a declaration", () => {
  // This is the whole point of the proof: an old default cannot satisfy D3.
  assertEquals(missingYoutubeDeclarations(explicitNo), [
    "youtube_made_for_kids",
    "youtube_contains_synthetic_media",
  ]);
  assertEquals(
    missingYoutubeDeclarations({ ...explicitNo, youtube_declaration_proof: { ...buildYoutubeDeclarationProof(explicitNo, "form"), version: YOUTUBE_DECLARATION_PROOF_VERSION - 1 } }),
    ["youtube_made_for_kids", "youtube_contains_synthetic_media"],
  );
  assertEquals(
    missingYoutubeDeclarations({ ...explicitNo, youtube_declaration_proof: { ...buildYoutubeDeclarationProof(explicitNo, "form"), made_for_kids: true } }),
    ["youtube_made_for_kids", "youtube_contains_synthetic_media"],
  );
});

Deno.test("an explicit No with a matching versioned proof survives", () => {
  const metadata = {
    ...explicitNo,
    youtube_declaration_proof: buildYoutubeDeclarationProof(explicitNo, "form"),
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

Deno.test("native dispatch refuses legacy defaults and accepts proven explicit No", () => {
  assertThrows(
    () => assertNativeYoutubeDeclarations({}),
    YoutubeDeclarationRequiredError,
  );
  assertThrows(
    () => assertNativeYoutubeDeclarations(explicitNo),
    YoutubeDeclarationRequiredError,
  );
  assertNativeYoutubeDeclarations({
    ...explicitNo,
    youtube_declaration_proof: buildYoutubeDeclarationProof(explicitNo, "form"),
  });
});

Deno.test("managed dispatch is refused for every post, including explicit No/No", () => {
  // The decision does not read the declaration values: a queued legacy post
  // and a fully declared post are refused by the same unconditional fence.
  const refusal = assertThrows(
    () => assertComposioYoutubeDeclarations(),
    YoutubeComposioDispatchUnavailableError,
  );
  assertEquals(refusal.code, "youtube_composio_dispatch_unavailable");
  assert(
    new YoutubeDeclarationRequiredError(["youtube_made_for_kids"]).code ===
      "youtube_declaration_required",
  );
});
