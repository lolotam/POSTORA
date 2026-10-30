import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { OpeninaryVideoError } from "../_shared/openinaryVideoTransform.ts";
import { parseTranscodeRequest } from "./request.ts";

Deno.test("the request TikTokPreCheck sends is accepted", () => {
  const parsed = parseTranscodeRequest({ media_file_id: "m1", user_id: "u1", target_platform: "tiktok" });
  assertEquals(parsed.target_platform, "tiktok");
});

Deno.test("the platform is optional", () => {
  assertEquals(parseTranscodeRequest({ media_file_id: "m1" }).target_platform, undefined);
});

Deno.test("a missing media id or a non-object body is an invalid request", () => {
  for (const body of [null, "x", {}, { media_file_id: "" }, { media_file_id: 5 }]) {
    const error = assertThrows(() => parseTranscodeRequest(body), OpeninaryVideoError);
    assertEquals(error.code, "INVALID_REQUEST");
  }
});
