import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { callChatCompletion } from "./ai-fallback.ts";
import type { AiRoutingAdmin } from "./ai-user-routing.ts";
import { defaultPiCallDeps } from "./aiOAuth/piCall.ts";
import { runTriage, selectConnectorTools, type TriageTier } from "./agentTriage.ts";

const tier: TriageTier = { provider: "claude", model: "claude-sonnet-4-5", authMethod: "oauth", kind: "chat" };
const input = { message: "price please", history: [], connectors: [{ name: "catalogue", description: "Prices" }], askHandoff: true };

for (const status of [401, 424]) {
  Deno.test(`real API dispatcher empty-body HTTP ${status} remains visible in triage errors`, async () => {
    const selected: TriageTier = { provider: `unconfigured-${status}`, model: "triage-chat", kind: "chat" };
    const apiKey = crypto.randomUUID();
    const admin = createClient("https://database.example.test", crypto.randomUUID(), { global: { fetch: async (url) => {
      const table = new URL(String(url)).pathname.split("/").at(-1);
      return Response.json(table === "provider_api_keys" && status === 424 ? { api_key: apiKey } : null);
    } } });
    const run = await runTriage([selected], input, () => { throw new Error("chat keys belong to dispatcher"); }, 1000, fetch, Date.now,
      (active, body, timeoutMs, signal) => callChatCompletion(admin as unknown as AiRoutingAdmin, active, body, timeoutMs, signal), true);
    assertEquals(run.outcome, null);
    assertEquals(run.errors, [{ model: `${selected.provider}/${selected.model}`, error: `HTTP ${status}` }]);
  });
}

for (const scenario of ["valid JSON", "invalid JSON", "master off", "reauth", "stalled credential"] as const) {
  Deno.test(`Triage through real subscription dispatcher: ${scenario}`, async () => {
    const reads: string[] = [];
    let inferred = false;
    const admin = createClient("https://database.example.test", crypto.randomUUID(), { global: { fetch: (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1)!;
      reads.push(path);
      if (path === "get_ai_oauth_credentials" && scenario === "stalled credential") return new Promise((_resolve, reject) => {
        const abort = () => reject(new DOMException("private credential data", "AbortError"));
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener("abort", abort, { once: true });
      });
      const data = path === "system_settings" ? { value: scenario !== "master off" } : path === "ai_providers" ? { is_active: true } :
        path === "get_ai_oauth_credentials" ? { status: scenario === "reauth" ? "reauth_required" : "connected",
          access: crypto.randomUUID(), refresh: crypto.randomUUID(), expires: Date.now() + 3_600_000 } : null;
      return Promise.resolve(Response.json(data));
    } } });
    const run = await runTriage([tier], input, () => { throw new Error("OAuth must never resolve an API key"); }, scenario === "stalled credential" ? 100 : 1500,
      fetch, Date.now, (selected, body, timeoutMs, signal) => callChatCompletion(admin as unknown as AiRoutingAdmin, selected, body, timeoutMs, signal, {
        pi: { ...defaultPiCallDeps(), complete: async (_model, context, options) => {
          inferred = true;
          assertEquals(options.maxTokens, 200);
          assertEquals((context as Record<string, unknown>).tools, undefined);
          return { content: [{ type: "text", text: scenario === "invalid JSON" ? "not JSON" : '{"smalltalk":0.01,"needs_knowledge":0.95}' }], stopReason: "stop" };
        } },
      }), true);
    assertEquals(reads.includes("provider_api_keys"), false);
    assertEquals(inferred, scenario === "valid JSON" || scenario === "invalid JSON");
    if (scenario === "valid JSON") assertEquals(run.outcome?.plan, { skipKnowledge: false, smalltalk: false, handoff: false, connectors: "all" });
    else {
      assertEquals(run.outcome, null);
      assertEquals(run.errors[0].error, scenario === "master off" ? "oauth_disabled" : scenario === "reauth" ? "reauth_required" : scenario === "invalid JSON" ? "unparseable answer" : "triage_deadline_exceeded");
      assertEquals(selectConnectorTools(input.connectors, null), input.connectors);
    }
  });
}
