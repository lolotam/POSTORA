import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FakeTime } from "https://deno.land/std@0.208.0/testing/time.ts";

const userId = crypto.randomUUID();
Deno.env.set("SUPABASE_URL", "https://database.example.test");
Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", crypto.randomUUID());
Deno.env.set("SUPABASE_ANON_KEY", crypto.randomUUID());
const { handleAiConfigRequest } = await import("./handler.ts");
const input = { action: "set-chat-tier", category: "chat", slot: "primary", provider_code: "openai", model_id: "test-model", expected: {} };
const encode = (body: unknown) => btoa(JSON.stringify(body)).replaceAll("=", "").replaceAll("+", "-").replaceAll("/", "_");
const token = [encode({ alg: ["HS", 256].join(""), typ: ["J", "WT"].join("") }), encode({ sub: userId, exp: 4_000_000_000 }), encode(crypto.randomUUID())].join(".");

for (const scenario of ["primary", "fallback", "fallback_2", "all Auth", "flag off", "non-admin", "conflict"] as const) {
  Deno.test(`HTTP Agent policy ${scenario}`, async () => {
    const original = globalThis.fetch;
    const writes: Array<{ p_key: string; p_expected: unknown }> = [];
    const logged: string[] = [];
    const api = { provider_code: "openai", model_id: "tool-api" };
    const auth = { provider_code: "claude", model_id: "claude-sonnet-4-5", auth_method: "oauth" };
    const expected = { default_ai_model_agent: api, default_ai_model_agent_fallback: api, default_ai_model_agent_fallback_2: api };
    const slot = scenario === "fallback" || scenario === "fallback_2" ? scenario : "primary";
    globalThis.fetch = async (url, init) => {
      const target = new URL(String(url));
      const path = target.pathname.split("/").at(-1);
      if (path === "user") return Response.json({ id: userId });
      if (path === "system_logs") { logged.push(JSON.parse(String(init?.body)).metadata.reason); return Response.json(null); }
      if (path === "write_ai_agent_tier") { writes.push(JSON.parse(String(init?.body))); return Response.json(scenario !== "conflict"); }
      return Response.json(path === "user_roles" ? (scenario === "non-admin" ? [] : [{ role: "admin" }]) :
        path === "system_settings" ? ["feature_ai_text_auth_lists", "feature_ai_provider_oauth", "feature_ai_oauth_tools_claude"].map(key => ({ key, value: key !== "feature_ai_oauth_tools_claude" || scenario !== "flag off" })) :
        path === "ai_providers" ? ["claude", "openai"].map(provider_code => ({ id: provider_code, provider_code, name: provider_code, is_active: true })) :
        path === "ai_models" && target.searchParams.get("offset") === "0" ? [{ provider_id: "openai", model_id: "tool-api", name: "API", capabilities: ["chat", "tools"], is_active: true }] :
        path === "get_ai_oauth_statuses" ? [{ provider_code: "claude", status: "connected" }] :
        path === "provider_api_keys" ? { api_key: crypto.randomUUID() } : []);
    };
    try {
      const response = await handleAiConfigRequest(new Request("https://edge.example.test/ai-config", { method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({
          action: "set-agent-tier", category: "agent", slot, ...auth,
          expected: scenario === "all Auth" ? { default_ai_model_agent: auth } : expected,
        }) }));
      const reason = scenario === "non-admin" ? "not_admin" : scenario === "all Auth" || scenario === "fallback_2" ? "oauth_api_fallback_required" :
        scenario === "flag off" ? "agent_model_tools_unavailable" : scenario === "conflict" ? "configuration_changed_retry" : null;
      assertEquals(response.status, reason ? scenario === "non-admin" ? 403 : 409 : 200);
      assertEquals(await response.json(), reason ? { error: reason } : { success: true });
      assertEquals(writes.length, !reason || scenario === "conflict" ? 1 : 0);
      if (writes.length) {
        assertEquals(writes[0].p_key, `default_ai_model_agent${slot === "primary" ? "" : `_${slot}`}`);
        assertEquals(writes[0].p_expected, expected);
      }
      assertEquals(logged, reason ? [reason] : []);
    } finally { globalThis.fetch = original; }
  });
}
async function flush() { for (let index = 0; index < 200; index++) await Promise.resolve(); }

// PR #419 r3: run the actual HTTP adapter with real SDKs, replacing only network and clock.
for (const stalled of ["user", "user_roles", "system_settings", "ai_models", "get_ai_oauth_statuses", "provider_api_keys", "write_ai_chat_tier"]) {
  Deno.test(`HTTP Chat save shares its entry deadline through ${stalled}`, async () => {
    const time = new FakeTime();
    const originalFetch = globalThis.fetch;
    const signals: AbortSignal[] = [];
    const pending: Array<() => void> = [];
    const writes: string[] = [];
    let reachedStall = false;
    let response: Response | undefined;
    globalThis.fetch = (url, init) => {
      const target = new URL(String(url));
      const table = target.pathname.split("/").at(-1)!;
      if (init?.method === "POST") writes.push(table);
      if (table === "system_logs") return Promise.resolve(Response.json(null));
      if (init?.signal) signals.push(init.signal);
      if (table === stalled) {
        reachedStall = true;
        return new Promise((_resolve, reject) => {
          const abort = () => reject(new DOMException("private upstream detail", "AbortError"));
          pending.push(abort);
          if (init?.signal?.aborted) abort();
          else init?.signal?.addEventListener("abort", abort, { once: true });
        });
      }
      // Authentication consumes 4s before database work starts. Later calls
      // must get the remaining 21s, never a fresh request-sized budget.
      if (table === "user") return new Promise(resolve => setTimeout(() => resolve(Response.json({ id: userId, email: "admin@example.test" })), 4_000));
      const rows = table === "user_roles" ? [{ role: "admin" }] :
        table === "system_settings" ? [{ key: "feature_ai_text_auth_lists", value: true }] :
        table === "ai_providers" ? [{ id: "p", provider_code: "openai", name: "OpenAI", is_active: true }] :
        table === "ai_models" && target.searchParams.get("offset") === "0" ? [{ id: "m", provider_id: "p", model_id: "test-model", name: "Test", is_active: true, capabilities: ["chat"] }] :
        table === "provider_api_keys" ? { api_key: crypto.randomUUID() } : [];
      return Promise.resolve(Response.json(table === "write_ai_chat_tier" ? true : rows));
    };
    const request = handleAiConfigRequest(new Request("https://edge.example.test/ai-config", {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input),
    })).then(value => { response = value; });
    try {
      await flush();
      time.tick(4_000);
      await flush();
      assert(reachedStall, `HTTP path must reach ${stalled}`);
      time.tick(20_999);
      await flush();
      assertEquals(response, undefined);
      time.tick(1);
      await flush();
      time.tick(250);
      await flush();
      assert(response, "HTTP request exceeded the single 25s deadline plus bounded refusal logging");
      assertEquals(response.status, 503);
      assertEquals(await response.json(), { error: "configuration_read_or_write_failed" });
      assert(signals.length > 0 && signals.every(signal => signal.aborted), "All operations must inherit the expired entry deadline");
      assertEquals(new Set(signals).size, 1, "Sequential operations must not restart their budgets");
      assertEquals(writes.filter(table => table === "write_ai_chat_tier").length, stalled === "write_ai_chat_tier" ? 1 : 0);
    } finally {
      pending.forEach(abort => abort());
      await flush();
      time.tick(250);
      await flush();
      await request;
      globalThis.fetch = originalFetch;
      time.restore();
    }
  });
}

for (const termination of ["deadline", "client abort"] as const) {
  Deno.test(`an incomplete authenticated body is cancelled on ${termination}`, async () => {
    const time = new FakeTime();
    const originalFetch = globalThis.fetch;
    const client = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | undefined;
    let cancelled = false;
    let response: Response | undefined;
    const body = new ReadableStream<Uint8Array>({
      start(controller) { bodyController = controller; controller.enqueue(new TextEncoder().encode('{"action":')); },
      cancel() { cancelled = true; },
    });
    globalThis.fetch = () => Promise.resolve(Response.json({ id: userId }));
    const request = handleAiConfigRequest(new Request("https://edge.example.test/ai-config", {
      method: "POST", headers: { Authorization: `Bearer ${token}` }, body, signal: client.signal,
    })).then(value => { response = value; });
    try {
      await flush();
      time.tick(24_999);
      await flush();
      assertEquals(response, undefined);
      if (termination === "deadline") time.tick(1);
      else client.abort();
      await flush();
      assert(response, "Incomplete request body exceeded its shared deadline or client cancellation");
      assertEquals(response.status, 503);
      assertEquals(await response.json(), { error: "configuration_read_or_write_failed" });
      assert(cancelled, "The body reader must be cancelled, not left consuming the stream");
    } finally {
      if (!cancelled) bodyController?.close();
      await request;
      globalThis.fetch = originalFetch;
      time.restore();
    }
  });
}

for (const scenario of ["primary", "fallback", "fallback_2", "Codex cap", "master off", "reauth", "non-admin", "conflict"] as const) {
  Deno.test(`HTTP Triage save: ${scenario}`, async () => {
    const original = globalThis.fetch;
    const writes: Array<Record<string, unknown>> = [];
    const logged: string[] = [];
    const expected: Record<string, unknown> = {};
    const sibling = JSON.stringify({ provider_code: "claude", model_id: "claude-sonnet-4-5", auth_method: "oauth", extension: { retain: true } });
    if (scenario === "fallback" || scenario === "fallback_2") expected.default_ai_model_agent_triage = sibling;
    if (scenario === "fallback_2") expected.default_ai_model_agent_triage_fallback = { provider_code: "claude", model_id: "claude-sonnet-4-5", auth_method: "oauth" };
    globalThis.fetch = (url, init) => {
      const path = new URL(String(url)).pathname.split("/").at(-1);
      if (path === "user") return Promise.resolve(Response.json({ id: userId }));
      if (path === "system_logs") { logged.push(JSON.parse(String(init?.body)).metadata.reason); return Promise.resolve(Response.json(null)); }
      if (path === "write_ai_triage_tier") { writes.push(JSON.parse(String(init?.body))); return Promise.resolve(Response.json(scenario !== "conflict")); }
      const data = path === "user_roles" ? (scenario === "non-admin" ? [] : [{ role: "admin" }]) :
        path === "system_settings" ? [{ key: "feature_ai_text_auth_lists", value: true }, { key: "feature_ai_provider_oauth", value: scenario !== "master off" }] :
        path === "ai_providers" ? [{ id: "claude", provider_code: "claude", name: "Claude", is_active: true }] :
        path === "get_ai_oauth_statuses" ? [{ provider_code: "claude", status: scenario === "reauth" ? "reauth_required" : "connected" }] :
        path === "provider_api_keys" ? null : [];
      return Promise.resolve(Response.json(data));
    };
    try {
      const response = await handleAiConfigRequest(new Request("https://edge.example.test/ai-config", {
        method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify({
          action: "set-triage-tier", category: "agent_triage", slot: scenario === "fallback" || scenario === "fallback_2" ? scenario : "primary",
          provider_code: scenario === "Codex cap" ? "openai" : "claude", model_id: scenario === "Codex cap" ? "gpt-5.4" : "claude-sonnet-4-5", auth_method: "oauth", expected,
        }),
      }));
      const refusal = scenario === "Codex cap" ? "oauth_max_tokens_unsupported" : scenario === "master off" ? "flag_off" :
        scenario === "reauth" ? "reauth_required" : scenario === "non-admin" ? "not_admin" : scenario === "conflict" ? "configuration_changed_retry" : null;
      assertEquals(response.status, refusal ? scenario === "non-admin" ? 403 : 409 : 200);
      assertEquals(await response.json(), refusal ? { error: refusal } : { success: true });
      if (!refusal || scenario === "conflict") {
        assertEquals(writes.length, 1);
        assertEquals(writes[0].p_expected, expected);
        assertEquals(writes[0].p_key, `default_ai_model_agent_triage${scenario === "fallback" || scenario === "fallback_2" ? `_${scenario}` : ""}`);
      } else assertEquals(writes.length, 0);
      assertEquals(logged, refusal ? [refusal] : []);
    } finally { globalThis.fetch = original; }
  });
}
