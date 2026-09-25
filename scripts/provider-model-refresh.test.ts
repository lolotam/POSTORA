// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { guessCapability } from "./provider-model-refresh.ts";

const CASES: Array<[string, string]> = [
  ["text-embedding-3-large", "embedding"],
  ["tts-1", "tts"],
  ["whisper-1", "stt"],
  ["gpt-4o-transcribe", "stt"],
  ["gpt-image-2", "image"],
  ["dall-e-3", "image"],
  ["grok-imagine-video", "video"],
  ["cogvideox", "video"],
  ["gpt-5.5", "chat"],
  ["claude-sonnet-5", "chat"],
];

Deno.test("guessCapability", async (t) => {
  for (const [modelId, expected] of CASES) {
    await t.step(`${modelId} -> ${expected}`, () => assertEquals(guessCapability(modelId), expected));
  }
});
