// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { guessCapability } from "./provider-model-refresh.ts";

Deno.test("guessCapability: text-embedding-3-large -> embedding", () => {
  assertEquals(guessCapability("text-embedding-3-large"), "embedding");
});

Deno.test("guessCapability: tts-1 -> tts", () => {
  assertEquals(guessCapability("tts-1"), "tts");
});

Deno.test("guessCapability: whisper-1 -> stt", () => {
  assertEquals(guessCapability("whisper-1"), "stt");
});

Deno.test("guessCapability: gpt-4o-transcribe -> stt", () => {
  assertEquals(guessCapability("gpt-4o-transcribe"), "stt");
});

Deno.test("guessCapability: gpt-image-2 -> image", () => {
  assertEquals(guessCapability("gpt-image-2"), "image");
});

Deno.test("guessCapability: dall-e-3 -> image", () => {
  assertEquals(guessCapability("dall-e-3"), "image");
});

Deno.test("guessCapability: grok-imagine-video -> video", () => {
  assertEquals(guessCapability("grok-imagine-video"), "video");
});

Deno.test("guessCapability: cogvideox -> video", () => {
  assertEquals(guessCapability("cogvideox"), "video");
});

Deno.test("guessCapability: gpt-5.5 -> chat", () => {
  assertEquals(guessCapability("gpt-5.5"), "chat");
});

Deno.test("guessCapability: claude-sonnet-5 -> chat", () => {
  assertEquals(guessCapability("claude-sonnet-5"), "chat");
});
