// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sttProviderFor } from "./sttProvider.ts";

Deno.test("returns the settings provider when the model matches the settings model", () => {
  assertEquals(sttProviderFor("vercel/whisper-1", "vercel/whisper-1", "vercel"), "vercel");
});

Deno.test("returns undefined when app_settings overrode the model", () => {
  assertEquals(sttProviderFor("nova-3", "vercel/whisper-1", "vercel"), undefined);
});

Deno.test("returns undefined when the caller's requestedModel overrode the model", () => {
  assertEquals(sttProviderFor("gemini-2.5-flash", "vercel/whisper-1", "vercel"), undefined);
});

Deno.test("returns undefined when the settings provider is empty even on a match", () => {
  assertEquals(sttProviderFor("whisper-1", "whisper-1", ""), undefined);
});
