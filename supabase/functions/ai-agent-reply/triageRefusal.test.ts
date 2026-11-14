import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runTriage, triageChainFromSettings, selectConnectorTools, type TriageRun, type TriageTier } from "../_shared/agentTriage.ts";
import { persistTriageRefusals } from "./triageRefusal.ts";

for (const slot of ["primary", "fallback", "fallback_2"] as const) {
  Deno.test(`malformed ${slot} persists a sanitized refusal while normal Agent access remains available`, async () => {
    const key = `default_ai_model_agent_triage${slot === "primary" ? "" : `_${slot}`}`;
    const triage: TriageRun = { outcome: null, errors: [] };
    const chain = triageChainFromSettings([
      { key: "agent_triage_enabled", value: { enabled: true } }, { key: "feature_ai_text_auth_lists", value: true },
      { key: "default_ai_model_agent_triage", value: { provider_code: "vercel", model_id: "valid" } },
      { key, value: '{"private_configuration":' },
    ], null, failure => triage.errors.push(failure));
    const writes: unknown[] = [];
    const admin = createClient("https://database.example.test", crypto.randomUUID(), { global: { fetch: async (url, init) => {
      assertEquals(new URL(String(url)).pathname, "/rest/v1/system_logs");
      writes.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    } } });
    await persistTriageRefusals(admin, triage, chain, Date.now() + 1000);
    assertEquals(writes, [{ level: "warn", category: "ai", source: "ai-agent-reply", message: "Triage refused; normal Agent fallback retained",
      metadata: { attempts: [{ model: key, error: "triage_configuration_invalid", auth_method: "api_key", slot }] } }]);
    assertEquals(triage.outcome, null);
    assertEquals(chain, []);
    const tools = [{ name: "catalogue" }];
    assertEquals(selectConnectorTools(tools, triage.outcome?.plan ?? null), tools);
  });
}

Deno.test("a failed refusal write never prevents the normal Agent reply", async () => {
  const admin = createClient("https://database.example.test", crypto.randomUUID(), { global: { fetch: async () => {
    throw new Error("private database details");
  } } });
  await persistTriageRefusals(admin, { outcome: null, errors: [{ model: "configuration", error: "triage_configuration_invalid" }] }, [], Date.now() + 1000);
});

// PR #421 round 2: chain position and saved slot differ after filtering/composition.
const decision = { provider_code: "vercel", model_id: "jev" };
const claudeApi = { provider_code: "claude", model_id: "claude-sonnet-4-5" };
const codex = { provider_code: "openai", model_id: "codex", auth_method: "oauth" };
for (const scenario of [
  { name: "filtered primary", primary: claudeApi, fallback: decision, slots: ["fallback", "fallback_2"] },
  { name: "missing primary", primary: null, fallback: decision, slots: ["fallback", "fallback_2"] },
  { name: "missing earlier slots", primary: null, fallback: null, slots: ["fallback_2"] },
  { name: "filtered middle", primary: decision, fallback: claudeApi, slots: ["primary", "fallback_2"] },
  { name: "skipped Codex", primary: codex, fallback: decision, slots: ["primary", "fallback", "fallback_2"] },
  { name: "prepended tier", primary: decision, fallback: decision, slots: [undefined, "primary", "fallback"] },
] as const) {
  Deno.test(`refusal logs preserve configured slots with a ${scenario.name}`, async () => {
    const configured = triageChainFromSettings([
      { key: "agent_triage_enabled", value: { enabled: true } }, { key: "feature_ai_text_auth_lists", value: true },
      { key: "default_ai_model_agent_triage", value: scenario.primary },
      { key: "default_ai_model_agent_triage_fallback", value: scenario.fallback },
      { key: "default_ai_model_agent_triage_fallback_2", value: decision },
    ]);
    // Triage has no user-first caller today; exercise that position shift at the writer boundary.
    const chain: TriageTier[] = [...(scenario.name === "prepended tier" ? [{ provider: "user-provider", model: "user-model", kind: "chat" as const }] : []), ...configured].slice(0, 3);
    const triage = await runTriage(chain, { message: "price", history: [], connectors: [], askHandoff: false },
      async () => crypto.randomUUID(), 1000, async () => new Response(null, { status: 503 }), Date.now,
      async () => new Response(null, { status: 503 }), true);
    const writes: unknown[] = [];
    const admin = createClient("https://database.example.test", crypto.randomUUID(), { global: { fetch: async (url, init) => {
      assertEquals(new URL(String(url)).pathname, "/rest/v1/system_logs");
      writes.push(JSON.parse(String(init?.body)));
      return new Response(null, { status: 201 });
    } } });
    await persistTriageRefusals(admin, triage, chain, Date.now() + 1000);
    assertEquals(triage.errors.length, scenario.slots.length);
    assertEquals(writes, [{ level: "warn", category: "ai", source: "ai-agent-reply", message: "Triage refused; normal Agent fallback retained",
      metadata: { attempts: chain.map((tier, index) => ({ model: `${tier.provider}/${tier.model}`, error: tier.provider === "openai" ? "oauth_max_tokens_unsupported" : "HTTP 503",
        provider: tier.provider, auth_method: tier.authMethod ?? "api_key", ...(scenario.slots[index] ? { slot: scenario.slots[index] } : {}) })) } }]);
    assertEquals(triage.outcome, null);
  });
}
