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
