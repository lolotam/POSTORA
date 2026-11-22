import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildYoutubeDeclarationProof } from "../_shared/youtubePublishSafety.ts";
import { parseExplicitDeclaration, YOUTUBE_DECLARATION_FORM_KEYS } from "./formDeclarations.ts";

Deno.test("only literal true and false become declaration booleans", () => {
  assertEquals(parseExplicitDeclaration("true"), true);
  assertEquals(parseExplicitDeclaration("false"), false);
  for (const value of ["1", "0", "TRUE", "", "yes", "no", "false ", "undefined"]) {
    assertEquals(parseExplicitDeclaration(value), value);
  }
});

Deno.test("a malformed declaration never builds a proof", () => {
  assertEquals(YOUTUBE_DECLARATION_FORM_KEYS.has("youtube_made_for_kids"), true);
  assertEquals(YOUTUBE_DECLARATION_FORM_KEYS.has("youtube_contains_synthetic_media"), true);

  const explicit = {
    youtube_made_for_kids: parseExplicitDeclaration("false"),
    youtube_contains_synthetic_media: parseExplicitDeclaration("true"),
  };
  assertEquals(buildYoutubeDeclarationProof(explicit, "rest"), {
    version: 3,
    made_for_kids: false,
    contains_synthetic_media: true,
    source: "rest",
  });

  // A legacy truthy token used to be parsed as `false`, silently producing a
  // full No/No declaration. It must now stay a string and be refused.
  const legacy = {
    youtube_made_for_kids: parseExplicitDeclaration("1"),
    youtube_contains_synthetic_media: parseExplicitDeclaration("on"),
  };
  assertEquals(buildYoutubeDeclarationProof(legacy, "rest"), null);
});
