import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { platformSupportsPrivateReply } from "./commentPlatforms.ts";

Deno.test("only Meta comment platforms can answer privately", () => {
  assertEquals(platformSupportsPrivateReply("facebook"), true);
  assertEquals(platformSupportsPrivateReply("instagram"), true);
  assertEquals(platformSupportsPrivateReply("threads"), false);
  assertEquals(platformSupportsPrivateReply("youtube"), false);
});
