// deno-lint-ignore-file no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { McpError } from "../_shared/higgsfield-mcp.ts";
import { HiggsfieldAuthError } from "../_shared/higgsfield-oauth.ts";
import {
  defaultImageRunDeps, generateWithModel, runImageGeneration, isDefinitiveHiggsfieldRejection, ProviderOutcomeUnknownError, PROVIDER_MIN_MS,
  type ImageRunDeps, type ResolvedModel,
} from "./runImageGeneration.ts";
import type { CallBudget } from "./callBudget.ts";

const google = { provider_code: "google", api_type: "google", model_id: "gemini-2.5-flash-image", api_endpoint: "https://g.invalid",
  api_key_env_var: "GOOGLE_AI_STUDIO_KEY", admin_params: {}, source: "primary" } as unknown as ResolvedModel;
const openai = { ...google, provider_code: "openai", api_type: "openai", model_id: "gpt-image-1" } as unknown as ResolvedModel;
const higgs = { ...google, provider_code: "higgsfield", api_type: "higgsfield", model_id: "hf-img" } as unknown as ResolvedModel;
const clock = { now: 0 };
const budget = (deadlineMs: number): CallBudget => ({ deadlineMs, now: () => clock.now, signal: () => new AbortController().signal });

function fakeDeps(over: Partial<ImageRunDeps> = {}) {
  const calls: string[] = [];
  const deps: ImageRunDeps = {
    onDispatch: async () => { calls.push("dispatch"); return true; },
    resolveChain: async () => [google],
    getApiKey: async () => "key",
    generateWithModel: async (m) => { calls.push(`gen:${m.model_id}`); return { imageUrl: "data:image/png;base64,AA", description: "d" }; },
    resolveHiggsfieldCredential: async () => ({ source: "platform" }),
    checkByoLimits: async () => ({ allowed: true }),
    reserveQuota: async () => { calls.push("reserve"); return true; },
    releaseQuota: async () => { calls.push("release"); },
    generateWithHiggsfield: async () => { calls.push("hf"); return { url: "https://hf.invalid/i.png", params: {} }; },
    recordHiggsfieldSuccess: async () => { calls.push("record"); },
    ...over,
  };
  return { deps, calls };
}
const job = (deadlineMs = Number.POSITIVE_INFINITY) => ({ userId: "u", prompt: "p", references: [], budget: budget(deadlineMs) });

Deno.test("first provider succeeds: one dispatch, no quota", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps();
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assertEquals(calls, ["dispatch", "gen:gemini-2.5-flash-image"]);
});
Deno.test("B1: confirmed Higgsfield refusal refunds once and falls back", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs, google],
    generateWithHiggsfield: async () => { calls.push("hf"); throw new McpError("rejected", undefined, "rejected"); },
  });
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assertEquals(calls, ["dispatch", "reserve", "hf", "release", "gen:gemini-2.5-flash-image"]);
});
Deno.test("B1: timeout after acceptance: one reserve, zero releases, no second provider", async () => {
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [higgs, google],
    generateWithHiggsfield: async () => { calls.push("hf"); throw new ProviderOutcomeUnknownError("Higgsfield did not respond within 30s"); },
  });
  const r = await runImageGeneration(deps, job());
  assertEquals(r.kind, "outcome_unknown");
  assertEquals(calls, ["dispatch", "reserve", "hf"]);
});
Deno.test("B1: a produced image is returned even if its bookkeeping insert fails", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], recordHiggsfieldSuccess: async () => { throw new Error("db"); } });
  assertEquals((await runImageGeneration(deps, job())).kind, "succeeded");
  assert(!calls.includes("release"));
});
Deno.test("B1: classification", () => {
  assert(isDefinitiveHiggsfieldRejection(new McpError("x", undefined, "rejected")));
  assert(isDefinitiveHiggsfieldRejection(new HiggsfieldAuthError("HIGGSFIELD_REAUTH_REQUIRED", "x")));
  assert(!isDefinitiveHiggsfieldRejection(new McpError("Higgsfield did not respond within 30s")));
  assert(!isDefinitiveHiggsfieldRejection(new TypeError("network")));
});
Deno.test("platform quota refused: 402 refusal, no provider call", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], reserveQuota: async () => false });
  assertEquals(await runImageGeneration(deps, job()),
    { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" });
  assert(!calls.includes("hf"));
});
Deno.test("BYO limit refused before any dispatch", async () => {
  const { deps, calls } = fakeDeps({ resolveChain: async () => [higgs], resolveHiggsfieldCredential: async () => ({ source: "byo" }),
    checkByoLimits: async () => ({ allowed: false, error: "Too many BYO jobs" }) });
  assertEquals(await runImageGeneration(deps, job()), { kind: "refused", status: 429, message: "Too many BYO jobs", errorCode: "ai_rate_limited" });
  assertEquals(calls, []);
});
Deno.test("lost lease aborts before any billable call", async () => {
  const { deps, calls } = fakeDeps({ onDispatch: async () => false });
  assertEquals((await runImageGeneration(deps, job())).kind, "lease_lost");
  assertEquals(calls, []);
});
Deno.test("B2: a fallback that would start near the end is skipped", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps({
    resolveChain: async () => [openai, google],
    generateWithModel: async (m) => { calls.push(`gen:${m.model_id}`); clock.now = 95_000; throw new Error("OpenAI 500"); },
  });
  const r = await runImageGeneration(deps, job(95_000 + PROVIDER_MIN_MS.google - 1));
  assertEquals(r.kind, "failed");
  assertEquals(calls, ["dispatch", "gen:gpt-image-1"]);
});
Deno.test("B2: the first candidate is skipped when its minimum does not fit", async () => {
  clock.now = 0;
  const { deps, calls } = fakeDeps({ resolveChain: async () => [openai, google] });
  await runImageGeneration(deps, job(PROVIDER_MIN_MS.openai - 1));
  assertEquals(calls, ["dispatch", "gen:gemini-2.5-flash-image"]);
});
Deno.test("every candidate failing reports today's message", async () => {
  clock.now = 0;
  const { deps } = fakeDeps({ getApiKey: async () => null });
  const r = await runImageGeneration(deps, job());
  assert(r.kind === "failed" && r.message.startsWith("All image providers failed. Attempts: "));
});

Deno.test("B2: slow references: the Google signal is taken after they are read", async () => {
  const originalFetch = globalThis.fetch;
  const seen: number[] = [];
  clock.now = 0;
  const callBudget: CallBudget = { deadlineMs: 100_000, now: () => clock.now,
    signal: (ms) => { seen.push(ms); return new AbortController().signal; } };
  globalThis.fetch = (async (input: string | URL | Request) => {
    if (String(input).includes(":generateContent")) {
      return Response.json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "AAAA" } }] } }] });
    }
    clock.now = 30_000;
    return new Response(new Uint8Array([137, 80, 78, 71]), { headers: { "Content-Type": "image/png" } });
  }) as typeof fetch;
  try {
    const result = await generateWithModel(google, "key", "p", "1:1", [{ url: "https://cdn.example/a.png", type: "style", priority: 1 }], callBudget);
    assertEquals(result.imageUrl, "data:image/png;base64,AAAA");
    assertEquals(seen, [20_000, 70_000]);
  } finally { globalThis.fetch = originalFetch; }
});

// Real routing, credentials, MCP and quota adapters; only database/HTTP/clock are faked.
function higgsfieldDatabase(rpcs: string[]) {
  return {
    from(table: string) {
      const rows: Record<string, unknown> = {
        system_settings: { value: { provider_code: "higgsfield", model_id: "nano_banana_2" } },
        ai_models: { model_id: "nano_banana_2", metadata: {}, admin_params: {},
          ai_providers: { provider_code: "higgsfield", api_type: "higgsfield", is_active: true } },
        provider_api_keys: { access_token: "test-token", api_key: "test-key" },
      };
      const b = new Proxy({}, { get: (_target, prop) => prop === "maybeSingle"
        ? () => Promise.resolve({ data: rows[table] ?? null, error: null }) : () => b });
      return b;
    },
    rpc(name: string) { rpcs.push(name); return Promise.resolve({ data: { allowed: true }, error: null }); },
  } as unknown as Parameters<typeof defaultImageRunDeps>[0];
}

for (const reset of [false, true]) {
  for (const failure of ["timeout", "5xx", "network"] as const) {
    Deno.test(`HIGH-1: real initialize ${failure}${reset ? " after 401" : ""} refunds and falls back`, async () => {
      const realFetch = globalThis.fetch;
      const rpcs: string[] = []; let initializes = 0; let generationCalls = 0; let fallbackCalls = 0;
      globalThis.fetch = (async (input, init) => {
        if (String(input).includes(":generateContent")) {
          fallbackCalls++;
          return Response.json({ candidates: [{ content: { parts: [{ inline_data: { mime_type: "image/png", data: "AAAA" } }] } }] });
        }
        const rpc = JSON.parse(String(init?.body));
        if (rpc.method === "initialize" && (++initializes > (reset ? 1 : 0))) {
          if (failure === "5xx") return new Response("unavailable", { status: 503 });
          throw failure === "timeout" ? new DOMException("initialize timed out", "TimeoutError") : new TypeError("network failed");
        }
        if (rpc.method === "tools/call") { generationCalls++; return new Response("expired", { status: 401 }); }
        return Response.json({ jsonrpc: "2.0", id: rpc.id, result: {} });
      }) as typeof fetch;
      try {
        const deps = defaultImageRunDeps(higgsfieldDatabase(rpcs), { onDispatch: async () => true, recordHiggsfieldSuccess: async () => {} });
        const result = await runImageGeneration(deps, job());
        assertEquals(result.kind, "succeeded"); // must never map to ai_outcome_unknown
        assertEquals(fallbackCalls, 1);
        assertEquals(generationCalls, reset ? 1 : 0);
        assertEquals(rpcs, ["reserve_ai_generation_quota", "release_ai_generation_quota"]);
      } finally { globalThis.fetch = realFetch; }
    });
  }
}

for (const worker of [false, true]) {
  Deno.test(`MEDIUM-5: real Higgsfield ${worker ? "worker uses remaining budget" : "sync keeps 30 seconds"}`, async () => {
    const realFetch = globalThis.fetch; const realNow = Date.now; const realTimeout = AbortSignal.timeout;
    let now = 1_000_000; let lastTimeout = 0;
    const seen: Array<[string, number]> = [];
    Date.now = () => now;
    AbortSignal.timeout = (ms) => { lastTimeout = ms; return new AbortController().signal; };
    globalThis.fetch = (async (_input, init) => {
      const rpc = JSON.parse(String(init?.body));
      seen.push([rpc.method, lastTimeout]);
      now += 1_000;
      return Response.json({ jsonrpc: "2.0", id: rpc.id, result: { url: "https://hf.invalid/image.png" } });
    }) as typeof fetch;
    try {
      const deps = defaultImageRunDeps(higgsfieldDatabase([]), { onDispatch: async () => true, recordHiggsfieldSuccess: async () => {} });
      const result = await runImageGeneration(deps, { ...job(), budget: {
        deadlineMs: worker ? now + 140_000 : Infinity, now: () => now, signal: (ms) => AbortSignal.timeout(ms),
      } });
      assertEquals(result.kind, "succeeded");
      assertEquals(seen, [["initialize", 30_000], ["notifications/initialized", 30_000], ["tools/call", worker ? 138_000 : 30_000]]);
    } finally { globalThis.fetch = realFetch; Date.now = realNow; AbortSignal.timeout = realTimeout; }
  });
}

for (const scenario of ['provider-metadata', 'storage-error'] as const) {
  Deno.test(`Higgsfield image ${scenario} never uses a colliding provider's metadata`, async () => {
    let queried = false;
    const admin = createClient('https://database.example.test', 'fixture', { global: { fetch: (async (input) => {
      const url = new URL(String(input));
      queried = true;
      assertEquals(url.searchParams.get('ai_providers.provider_code'), 'eq.higgsfield');
      assertEquals(url.searchParams.get('auth_method'), 'eq.api_key');
      assertEquals(url.searchParams.get('model_id'), 'eq.shared-image-model');
      if (scenario === 'storage-error') return Response.json({ message: 'fixture storage failure' }, { status: 503 });
      return Response.json({ metadata: { parameters: [{ name: 'vendor_required', type: 'string', required: true }] } });
    }) as typeof fetch } });
    const deps = defaultImageRunDeps(admin, { onDispatch: async () => true, recordHiggsfieldSuccess: async () => {} });
    await assertRejects(() => deps.generateWithHiggsfield({ m: { ...higgs, model_id: 'shared-image-model' },
      cred: {}, prompt: 'p', rawPrompt: 'p', references: [], userId: 'fixture', budget: budget(Infinity) }), Error,
      scenario === 'storage-error' ? 'Image model configuration could not be read' : 'needs vendor_required');
    assert(queried);
  });
}
