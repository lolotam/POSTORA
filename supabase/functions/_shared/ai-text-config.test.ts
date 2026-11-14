import type { AiRoutingAdmin } from "./ai-user-routing.ts";
import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import * as fallback from "./ai-fallback.ts";

const api = (model_id: string) => ({ provider_code: "google", model_id });
type Resolver = (db: SupabaseClient, user: string | null, category: "caption" | "hashtags") => ReturnType<typeof fallback.resolveChatModelConfig>;
const resolve = (fallback as unknown as { resolveTextModelConfig?: typeof fallback.resolveChatModelConfig }).resolveTextModelConfig ?? fallback.resolveChatModelConfig;
function database(rows: Array<{ key: string; value: unknown }>, override: unknown = null, fail = false) {
  return createClient("https://fixture.invalid", crypto.randomUUID(), { global: { fetch: async input => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("user_ai_model_overrides")) return Response.json(override);
    if (url.pathname.endsWith("ai_models")) return Response.json({ id: "known" });
    if (fail) return Response.json({ message: "private failure" }, { status: 500 });
    const keys = url.searchParams.get("key") ?? "";
    return Response.json(rows.filter(row => keys.includes(row.key)));
  } } });
}
for (const category of ["caption", "hashtags"] as const) {
  Deno.test(`${category} resolves its complete ladder instead of Chat`, async () => {
    const db = database([{ key: "feature_ai_category_text_ladders", value: true },
      { key: "default_ai_model_chat", value: api("chat") },
      { key: `default_ai_model_${category}`, value: JSON.stringify(api(category)) }]);
    const config = await (resolve as Resolver)(db, null, category);
    assertEquals(config.primaryModel, category);
    assertEquals(config.fallbackModel, "");
    assertEquals(config.lastResortModel, "gemini-3-flash-preview");
  });
  Deno.test(`${category} inherits Chat with no rows and ignores saved rows with flag off`, async () => {
    for (const enabled of [true, false]) {
      const rows = [{ key: "feature_ai_category_text_ladders", value: enabled }, { key: "default_ai_model_chat", value: api("chat") }];
      if (!enabled) rows.push({ key: `default_ai_model_${category}`, value: api("ignored") });
      const { categoryEnabled: _enabled, ...resolved } = await (resolve as Resolver)(database(rows), null, category);
      assertEquals(resolved, await fallback.resolveChatModelConfig(database(rows), null));
    }
  });
  Deno.test(`${category} refuses partial and malformed ladders rather than mixing Chat`, async () => {
    for (const suffix of ["", "_fallback", "_fallback_2"]) {
      await assertRejects(() => (resolve as Resolver)(database([
        { key: "feature_ai_category_text_ladders", value: true },
        { key: `default_ai_model_${category}${suffix}`, value: suffix ? api("orphan") : { provider_code: "google" } },
      ]), null, category));
    }
  });
  Deno.test(`${category} keeps override expiry and shifts the selected category`, async () => {
    const rows = [{ key: "feature_ai_category_text_ladders", value: true }, { key: `default_ai_model_${category}`, value: api(category) }];
    const active = await (resolve as Resolver)(database(rows, { provider: "openai", model: "override", expires_at: null }), "owner", category);
    assertEquals([active.primaryModel, active.fallbackModel], ["override", category]);
    const expired = await (resolve as Resolver)(database(rows, { provider: "openai", model: "expired", expires_at: "2000-01-01" }), "owner", category);
    assertEquals(expired.primaryModel, category);
  });
}
Deno.test("category configuration read failures refuse instead of inheriting", async () => {
  await assertRejects(() => (resolve as Resolver)(database([], null, true), null, "caption"));
});

Deno.test("cap validation follows user-first composition and the three-tier cap", async () => {
  const { composeAiTiers } = await import("./ai-user-routing.ts");
  const codex = { provider: "openai", model: "same", credentialSource: "platform" as const, authMethod: "oauth" as const };
  const compatible = { provider: "claude", model: "same", credentialSource: "platform" as const, authMethod: "oauth" as const };
  // An API override displaced by the cap cannot rescue a three-Codex chain.
  const capped = composeAiTiers({ mode: "postora_only", allowPlatformFallback: false }, [codex, codex, codex, compatible]);
  const refused = await fallback.callAiChain(undefined, { max_tokens: 4096 }, capped, { enforceOutputCap: true });
  assertEquals(refused.errorCode, "ai_output_cap_unsupported");
  assertEquals(refused.tiers.map(tier => tier.error), Array(3).fill("oauth_max_tokens_unsupported"));
  assertEquals(composeAiTiers({ mode: "user_only", allowPlatformFallback: false }, [compatible]), []);
});

Deno.test("capped Codex skips credentials and preserves the cap on the configured API recovery", async () => {
  const previousFetch = globalThis.fetch;
  const observed: string[] = [];
  const bodies: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    observed.push(url.pathname.split("/").at(-1)!);
    if (url.hostname === "fixture.invalid") return Response.json({ api_key: crypto.randomUUID() });
    bodies.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { content: "Synthetic recovery" } }] });
  };
  try {
    const db = createClient("https://fixture.invalid", crypto.randomUUID());
    const result = await fallback.callAiChain(db as unknown as AiRoutingAdmin, { max_tokens: 4096 }, [
      { provider: "openai", model: "same", credentialSource: "platform", authMethod: "oauth" },
      { provider: "google", model: "recovery", credentialSource: "platform" },
    ], { enforceOutputCap: true, deadlineAt: Date.now() + 10_000 });
    assertEquals(result.modelUsed, "recovery");
    assertEquals(result.tiers[0].error, "oauth_max_tokens_unsupported");
    assertEquals(observed, ["provider_api_keys", "completions"]);
    assertEquals(bodies[0].max_tokens, 4096);
  } finally { globalThis.fetch = previousFetch; }
});
