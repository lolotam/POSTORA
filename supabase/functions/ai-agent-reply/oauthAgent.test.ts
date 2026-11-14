import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { defaultCredentialDeps } from "../_shared/aiOAuth/credentials.ts";
import type { OAuthChainDeps } from "../_shared/aiOAuth/chainTier.ts";
import { OAuthContinuation } from "../_shared/aiOAuth/toolTranscript.ts";
import { AuthActionLedger, authActionSafety } from "./authToolSafety.ts";
import { selectAgentCompletion } from "./modelRound.ts";
import { ModelChainExhaustedError } from "./logic.ts";
import { WAITLIST_FOLLOW_UP } from "./procedureRuntime.ts";
import type { AiTier } from "../_shared/ai-fallback.ts";
import type { AiRoutingAdmin } from "../_shared/ai-user-routing.ts";
import { agentRecoveryReady } from "./agentRecoveryReadiness.ts";

const serve = Deno.serve;
let chatCompletion: typeof import("./index.ts").chatCompletion;
try {
  Deno.serve = (() => ({})) as unknown as typeof Deno.serve;
  ({ chatCompletion } = await import("./index.ts"));
} finally { Deno.serve = serve; }

const tool = { type: "function", function: { name: "search_knowledge", description: "Look up hours", parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] } } };
const request = { messages: [{ role: "user", content: "hours?" }], tools: [tool], tool_choice: "auto" };
const mutationTool = { type: "function", function: { name: "stock_waitlist_join", description: "Join the already verified store waitlist", parameters: { type: "object", properties: { product_id: { type: "string" } }, required: ["product_id"] } } };
const auth: AiTier = { provider: "claude", model: "claude-sonnet-4-5", authMethod: "oauth", credentialSource: "platform" };
function oauthDeps(complete: NonNullable<OAuthChainDeps["pi"]>["complete"]): OAuthChainDeps {
  const admin = { rpc: () => {
    const promise = Promise.resolve({ data: { access: crypto.randomUUID(), refresh: "", expires: Date.now() + 600_000, status: "connected" }, error: null });
    return Object.assign(promise, { abortSignal: () => promise });
  } } as unknown as SupabaseClient;
  return { enabled: async () => true, providerActive: async () => true, toolsEnabled: async () => true,
    continuation: new OAuthContinuation(), credentials: { ...defaultCredentialDeps(admin), getApiKey: (_provider, credentials) => String(credentials.access) },
    pi: { getModel: () => ({ provider: "anthropic", api: "anthropic-messages", id: auth.model }), complete } };
}

async function recoverAction(messages: unknown[], args: Record<string, unknown>) {
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/rest/v1/")) return Response.json({ api_key: crypto.randomUUID() });
    const payload = JSON.parse(String(init?.body));
    assertEquals(payload.messages, messages);
    assertEquals(payload.tools, [tool, mutationTool]);
    return Response.json({ choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "new_api_call", type: "function", function: {
      name: "stock_waitlist_join", arguments: JSON.stringify(args),
    } }] } }] });
  };
  try {
    const admin = createClient("https://database.example.test", crypto.randomUUID()) as unknown as AiRoutingAdmin;
    const chain: AiTier[] = [auth, { provider: "openai", model: "chosen-api", credentialSource: "platform" }];
    const result = await selectAgentCompletion({ tiers: 2, budget: () => 1000,
      attempt: index => chatCompletion(chain[index], { messages, tools: [tool, mutationTool], tool_choice: "auto" }, 1000, admin,
        oauthDeps(async () => { throw new Error("Auth outage"); })), failed: async () => {} });
    assert("completion" in result);
    assertEquals(result.index, 1);
    return result.completion.choices[0].message.tool_calls![0];
  } finally { globalThis.fetch = original; }
}

Deno.test("real main Agent dispatch performs Claude tools and a final history round with no API lookup", async () => {
  const admin = { from: () => { throw new Error("API key/endpoint lookup forbidden"); } } as unknown as AiRoutingAdmin;
  let calls = 0;
  const deps = oauthDeps(async (_model, context) => {
    calls++;
    if (calls === 1) return { content: [{ type: "toolCall", id: "a", name: tool.function.name, arguments: { query: "hours" } }], stopReason: "toolUse" };
    assertEquals((context as { messages: Array<{ role: string }> }).messages.at(-1)?.role, "toolResult");
    return { content: [{ type: "text", text: "Open until 5." }], stopReason: "stop" };
  });
  const first = await chatCompletion(auth, request, 1000, admin, deps);
  assertEquals(first.choices[0].message.tool_calls?.[0].function.name, "search_knowledge");
  const final = await chatCompletion(auth, { messages: [...request.messages, first.choices[0].message,
    { role: "tool", tool_call_id: "a", content: "Open until 5" }] }, 1000, admin, deps);
  assertEquals(final.choices[0].message.content, "Open until 5.");
  assertEquals(calls, 2);
});

Deno.test("Agent selected-completion seam falls through an Auth outage preserving tools and completed history", async () => {
  const original = globalThis.fetch;
  const sent: Array<Record<string, unknown>> = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/rest/v1/")) return Response.json({ api_key: crypto.randomUUID() });
    sent.push(JSON.parse(String(init?.body)));
    return Response.json({ choices: [{ message: { role: "assistant", content: "Recovered." } }] });
  };
  try {
    const admin = createClient("https://database.example.test", crypto.randomUUID()) as unknown as AiRoutingAdmin;
    const chain: AiTier[] = [auth, { provider: "openai", model: "chosen-api", credentialSource: "platform" }];
    const transcript = { ...request, messages: [...request.messages, { role: "assistant", content: null,
      tool_calls: [{ id: "read_a", type: "function", function: { name: tool.function.name, arguments: '{"query":"hours"}' } }] },
      { role: "tool", tool_call_id: "read_a", content: "Open until 5" }] };
    const errors: unknown[] = [];
    const result = await selectAgentCompletion({ tiers: 2, budget: () => 1000,
      attempt: index => chatCompletion(chain[index], transcript, 1000, admin, oauthDeps(async () => { throw new Error("private upstream failure"); })),
      failed: async (_index, cause) => { errors.push(cause instanceof Error ? cause.message : cause); } });
    assert("completion" in result);
    assertEquals(result.index, 1);
    assertEquals(result.completion.choices[0].message.content, "Recovered.");
    assertEquals(sent[0].tools, request.tools);
    assertEquals(sent[0].messages, transcript.messages);
    assertEquals(errors, ["oauth_http_502"]);
  } finally { globalThis.fetch = original; }
});

for (const stage of ["before execution", "after read", "after completed mutation", "unknown mutation"] as const) {
  Deno.test(`Auth fallback side effects: ${stage}`, async () => {
    let externalMutations = 0;
    let reads = 0;
    const logs: string[] = [];
    const ledger = new AuthActionLedger(crypto.randomUUID(), code => { logs.push(code); });
    const write = async () => { externalMutations++; if (stage === "unknown mutation") throw new Error("vendor outcome lost"); return { output: "saved" }; };
    const safety = authActionSafety("stock_waitlist_join", new Map());
    const firstArgs = { product_id: "25", request_id: crypto.randomUUID(), nested: { nonce: crypto.randomUUID(), amount: 1 } };
    if (stage === "after read") await ledger.execute("search_knowledge", { query: "hours" }, { kind: "read" }, async () => { reads++; return { output: "hours" }; });
    if (stage === "after completed mutation") await ledger.execute("stock_waitlist_join", firstArgs, safety, write);
    if (stage === "unknown mutation") await assertRejects(() => ledger.execute("stock_waitlist_join", firstArgs, safety, write), ModelChainExhaustedError, "oauth_action_outcome_unknown");
    // A fallback model supplies a NEW call ID and nonce. Neither enters the action identity.
    const changedArgs = { nested: { amount: 1, nonce: crypto.randomUUID() }, request_id: crypto.randomUUID(), fresh_model_field: crypto.randomUUID(), product_id: 25 };
    const messages: unknown[] = [...request.messages];
    if (stage === "after read" || stage === "after completed mutation") {
      const name = stage === "after read" ? "search_knowledge" : "stock_waitlist_join";
      messages.push({ role: "assistant", content: null, tool_calls: [{ id: "previous_auth_call", type: "function", function: { name, arguments: JSON.stringify(stage === "after read" ? { query: "hours" } : firstArgs) } }] },
        { role: "tool", tool_call_id: "previous_auth_call", content: stage === "after read" ? "hours" : "saved" });
    }
    const recoveredCall = stage === "unknown mutation" ? null : await recoverAction(messages, changedArgs);
    const replay = () => ledger.execute(recoveredCall?.function.name ?? "stock_waitlist_join",
      recoveredCall ? JSON.parse(recoveredCall.function.arguments) : changedArgs, safety, write);
    if (stage === "unknown mutation") await assertRejects(replay, ModelChainExhaustedError, "oauth_action_outcome_unknown");
    else assertEquals((await replay()).output, "saved");
    assertEquals(externalMutations, 1);
    assertEquals(logs.includes("oauth_duplicate_action_suppressed"), stage === "after completed mutation");
    if (stage === "after read") {
      await ledger.execute("search_knowledge", { query: "hours" }, { kind: "read" }, async () => { reads++; return { output: "hours" }; });
      assertEquals(reads, 2);
    }
  });
}
Deno.test("unsafe mutation blocks execution; ambiguous waitlist outcome blocks continuation", async () => {
  const ledger = new AuthActionLedger(crypto.randomUUID(), () => {});
  let mutations = 0;
  await assertRejects(() => ledger.execute("notify_admin", {}, authActionSafety("notify_admin", new Map()), async () => { mutations++; return { output: "sent" }; }), ModelChainExhaustedError, "oauth_tool_safety_unsupported");
  assertEquals(mutations, 0);
  await assertRejects(() => ledger.execute("stock_waitlist_join", { product_id: "25" }, authActionSafety("stock_waitlist_join", new Map()), async () => ({ output: WAITLIST_FOLLOW_UP })), ModelChainExhaustedError, "oauth_action_outcome_unknown");
});

Deno.test("effective recovery preflight reads only later platform model readiness, never API keys", async () => {
  const original = globalThis.fetch;
  const tables: string[] = [];
  let active = true;
  globalThis.fetch = async url => {
    const path = new URL(String(url)).pathname.split("/").at(-1)!;
    tables.push(path);
    if (path === "ai_providers") return Response.json({ id: "provider", is_active: true });
    if (path === "ai_models") return Response.json({ capabilities: ["chat", "tools"], metadata: null, is_active: active });
    throw new Error("credential lookup forbidden in capability preflight");
  };
  try {
    const admin = createClient("https://database.example.test", crypto.randomUUID());
    const chain: AiTier[] = [auth, { provider: "openai", model: "chosen-api", credentialSource: "platform" }];
    assertEquals(await agentRecoveryReady(admin, chain, 0, AbortSignal.timeout(1000)), true);
    active = false;
    assertEquals(await agentRecoveryReady(admin, chain, 0, AbortSignal.timeout(1000)), false);
    assertEquals(await agentRecoveryReady(admin, [chain[1], auth], 1, AbortSignal.timeout(1000)), false);
    assert(tables.every(table => ["ai_providers", "ai_models"].includes(table)));
  } finally { globalThis.fetch = original; }
});
