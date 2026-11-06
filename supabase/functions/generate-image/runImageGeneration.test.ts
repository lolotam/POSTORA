// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { McpError } from "../_shared/higgsfield-mcp.ts";
import { HiggsfieldAuthError } from "../_shared/higgsfield-oauth.ts";
import {
  generateWithModel, runImageGeneration, isDefinitiveHiggsfieldRejection, ProviderOutcomeUnknownError, PROVIDER_MIN_MS,
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
