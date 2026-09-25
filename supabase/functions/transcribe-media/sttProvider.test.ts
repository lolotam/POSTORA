// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sttLastResort, sttProviderFor } from "./sttProvider.ts";

// Each row is [case, resolved model, settings model, settings provider, expected provider].
const CASES: Array<[string, string, string, string, string | undefined]> = [
  ["the settings provider when the model matches the settings model", "vercel/whisper-1", "vercel/whisper-1", "vercel", "vercel"],
  ["undefined when app_settings overrode the model", "nova-3", "vercel/whisper-1", "vercel", undefined],
  ["undefined when the caller's requestedModel overrode the model", "gemini-2.5-flash", "vercel/whisper-1", "vercel", undefined],
  ["undefined when the settings provider is empty even on a match", "whisper-1", "whisper-1", "", undefined],
];

Deno.test("sttProviderFor", async (t) => {
  for (const [name, model, settingsModel, settingsProvider, expected] of CASES) {
    await t.step(name, () => assertEquals(sttProviderFor(model, settingsModel, settingsProvider), expected));
  }
});

Deno.test("sttLastResort uses the configured Vercel model only when the admin chose the vercel provider", () => {
  assertEquals(sttLastResort("vercel", "openai/gpt-4o-transcribe"), { model: "openai/gpt-4o-transcribe", provider: "vercel" });
  assertEquals(sttLastResort("google", "gemini-3-flash-preview"), { model: "whisper-1", provider: undefined });
  assertEquals(sttLastResort("openai", "whisper-1"), { model: "whisper-1", provider: undefined });
  assertEquals(sttLastResort("vercel", ""), { model: "whisper-1", provider: undefined });
});
