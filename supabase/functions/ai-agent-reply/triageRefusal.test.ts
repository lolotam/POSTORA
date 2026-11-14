import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { triageChainFromSettings, selectConnectorTools, type TriageRun } from "../_shared/agentTriage.ts";
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
