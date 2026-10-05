// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { fetchCategoryAiSettings } from "./ai-fallback.ts";

/** `knownModels` are the (provider, model) pairs that exist and are active in ai_models. */
function adminWith(
  rows: Array<{ key: string; value: unknown }>,
  knownModels: string[] = ["gemini/gemini-2.5-flash"],
) {
  return {
    from: (table: string) => {
      if (table === "ai_models") {
        let model = "", provider = "";
        const chain: any = {
          select: () => chain,
          eq: (col: string, val: string) => {
            if (col === "model_id") model = val;
            if (col.includes("provider_code")) provider = val;
            return chain;
          },
          maybeSingle: () =>
            Promise.resolve({
              data: knownModels.includes(`${provider}/${model}`) ? { id: "m1" } : null,
            }),
        };
        return chain;
      }
      return { select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) };
    },
  } as any;
}

Deno.test("the admin's third tier is used, not the hardcoded floor", async () => {
  // The UI writes _fallback_2 (useAIConfiguration.ts:126). Ignoring it silently discarded
  // whatever the operator chose as last resort.
  const s = await fetchCategoryAiSettings(adminWith([
    { key: "default_ai_model_stt", value: { provider_code: "elevenlabs", model_id: "scribe_v2" } },
    { key: "default_ai_model_stt_fallback", value: { provider_code: "openai", model_id: "whisper-1" } },
    { key: "default_ai_model_stt_fallback_2", value: { provider_code: "gemini", model_id: "gemini-2.5-flash" } },
  ]), "stt");
  assertEquals(s.primaryProvider, "elevenlabs");
  assertEquals(s.primaryModel, "scribe_v2");
  assertEquals(s.fallbackProvider, "openai");
  assertEquals(s.lastResortProvider, "gemini");
  assertEquals(s.lastResortModel, "gemini-2.5-flash");
});

Deno.test("without a third tier the hardcoded floor still applies", async () => {
  const s = await fetchCategoryAiSettings(adminWith([
    { key: "default_ai_model_stt", value: { provider_code: "elevenlabs", model_id: "scribe_v2" } },
  ]), "stt");
  assertEquals(s.lastResortProvider, "openai");
  assertEquals(s.lastResortModel, "whisper-1");
});

Deno.test("_fallback_2 is not mistaken for _fallback", async () => {
  const s = await fetchCategoryAiSettings(adminWith([
    { key: "default_ai_model_stt_fallback_2", value: { provider_code: "gemini", model_id: "gemini-2.5-flash" } },
  ]), "stt");
  assertEquals(s.fallbackProvider, "", "the second tier must stay empty");
  assertEquals(s.lastResortProvider, "gemini");
});

Deno.test("a third tier naming a model that is not in the catalog is ignored", async () => {
  // The real row that motivated this guard: default_ai_model_chat_fallback_2 held
  // openrouter/nvidia/nemotron-3-ultra-550b-a55b:free, absent from ai_models. It had been
  // inert while nothing read _fallback_2; honouring it blindly would have replaced chat's
  // known-good floor with an unvalidated model.
  const s = await fetchCategoryAiSettings(adminWith([
    { key: "default_ai_model_chat", value: { provider_code: "gemini", model_id: "gemini-2.5-flash" } },
    {
      key: "default_ai_model_chat_fallback_2",
      value: { provider_code: "openrouter", model_id: "nvidia/nemotron-3-ultra-550b-a55b:free" },
    },
  ]), "chat");
  assertEquals(s.lastResortProvider, "google", "must fall back to the hardcoded floor");
  assertEquals(s.lastResortModel, "gemini-3-flash-preview");
});

Deno.test("search and video have no floor: an unset last resort stays empty, never the chat model", async () => {
  for (const category of ["search", "video"]) {
    const s = await fetchCategoryAiSettings(adminWith([]), category);
    assertEquals([s.lastResortProvider, s.lastResortModel], ["", ""], category);
  }
  // A category missing from the map still gets chat's floor, as before.
  const unknown = await fetchCategoryAiSettings(adminWith([]), "something_new");
  assertEquals([unknown.lastResortProvider, unknown.lastResortModel], ["google", "gemini-3-flash-preview"]);
});
