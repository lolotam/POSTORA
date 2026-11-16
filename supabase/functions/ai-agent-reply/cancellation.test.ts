import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import type { AiRoutingAdmin } from "../_shared/ai-user-routing.ts";
import { clearProviderEndpointCache } from "../_shared/providerEndpoint.ts";
import { fetchWithTimeout } from "../_shared/ai-fallback.ts";
import { boundAgentSender, createAgentClients } from "./requestBudget.ts";
import { deliverGeneratedReply, deliverStoredReply } from "./outbox.ts";
import { releaseFailedEscalationTurn, releaseUnpersistedEscalation } from "./handoffWindow.ts";

const serve = Deno.serve;
let chatCompletion: typeof import("./index.ts").chatCompletion;
let handleReply: (request: Request) => Promise<Response>;
try {
  Deno.serve = ((handler: typeof handleReply) => { handleReply = handler; return {}; }) as unknown as typeof Deno.serve;
  ({ chatCompletion } = await import("./index.ts"));
} finally { Deno.serve = serve; }
const payload = { model: "configured-model", messages: [{ role: "user", content: "hours?" }] };

Deno.test("delivery persistence failure releases its lease and retryable turn before slow error logging", async () => {
  const original = globalThis.fetch;
  const savedEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].map(name => [name, Deno.env.get(name)] as const);
  const key = crypto.randomUUID();
  Deno.env.set("SUPABASE_URL", "https://database.example.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", key);
  let state = "pending";
  let leaseHeld = false;
  let persistenceRefused = false;
  let errorLogged = false;
  let stateBeforeLog: string | undefined;
  const marker = new Date(Date.now() - 60_000).toISOString();
  const account = { id: "account", platform_user_id: "phone", access_token: crypto.randomUUID(), connection_mode: "cloud_api", account_metadata: {} };
  globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const table = url.pathname.split("/").at(-1)!;
    const args = init?.body ? JSON.parse(String(init.body)) : {};
    const select = url.searchParams.get("select") ?? "";
    if (url.pathname.endsWith("/chat/completions")) return Response.json({ choices: [{ message: { role: "assistant", content: "Our hours are nine to five." } }] });
    if (args.p_from) {
      assertEquals(args.p_from, state);
      if (args.p_to === "ready_to_send") { persistenceRefused = true; return Response.json(false); }
      state = args.p_to;
      return Response.json(true);
    }
    if (table === "claim_unanswered_escalation") { leaseHeld = true; return Response.json({ marker, token: "claim" }); }
    if (table === "release_unanswered_escalation_claim") { leaseHeld = false; return Response.json(true); }
    if (table === "ai_agent_logs" && args.status === "error") {
      stateBeforeLog = state;
      // Longer than the reserved two-second cleanup lane, shorter than settlement.
      await new Promise(resolve => setTimeout(resolve, 2100));
      errorLogged = true;
      return Response.json(null);
    }
    if (init?.method === "POST" && table !== "ai_threads") return Response.json(null);
    if (table === "ai_agent_configs") return Response.json({ is_enabled: true, default_mode: "ai_first", reply_cooldown_seconds: 0, daily_message_cap: 0, language_mode: "en" });
    if (table === "social_accounts") return Response.json(account);
    if (table === "ai_threads") return Response.json(select === "unanswered_escalation_since" ? { unanswered_escalation_since: marker } : { id: "thread" });
    if (table === "pending_agent_replies") return Response.json({ user_id: "owner", status: state });
    if (table === "whatsapp_messages" && select === "timestamp") return Response.json({ timestamp: new Date().toISOString() });
    if (table === "system_settings") return Response.json([{ key: "default_ai_model_agent", value: { provider_code: "openai", model_id: "configured-model" } }]);
    if (table === "ai_providers") return Response.json({ api_endpoint: "https://provider.example.test/v1", api_type: "openai", is_active: true });
    if (table === "provider_api_keys") return Response.json({ api_key: key });
    if (["app_settings", "user_feature_overrides", "user_ai_routing_preferences", "ai_conversation_modes", "conversation_assignments", "whatsapp_conversations"].includes(table)) return Response.json(null);
    return Response.json([], { headers: { "content-range": "0-0/0" } });
  };
  try {
    const response = await handleReply(new Request("https://function.example.test", { method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({ user_id: "owner", platform: "whatsapp", social_account_id: "account", conversation_id: "conversation",
        phone_number_id: "phone", recipient_phone: "recipient", inbound_text: "What are your hours?", outbox_id: "10000000-0000-4000-8000-000000000001" }) }));
    assertEquals((await response.json()).ok, false);
    assertEquals(persistenceRefused, true);
    assertEquals(errorLogged, true);
    assertEquals(leaseHeld, false);
    assertEquals(state, "pending");
    assertEquals(stateBeforeLog, "pending");
  } finally {
    globalThis.fetch = original;
    clearProviderEndpointCache();
    for (const [name, value] of savedEnv) { if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value); }
  }
});

for (const mode of ["fresh", "stored"] as const) Deno.test(`${mode} outbox retries a cancellation after claim but before transport exactly once`, async () => {
  const original = globalThis.fetch;
  const caller = new AbortController();
  const clients = createAgentClients("https://database.example.test", crypto.randomUUID(), caller.signal);
  let state = mode === "fresh" ? "running" : "ready_to_send";
  let sends = 0;
  globalThis.fetch = async (_url, init) => {
    init?.signal?.throwIfAborted();
    const args = JSON.parse(String(init?.body));
    assertEquals(args.p_from, state);
    state = args.p_to;
    return Response.json(true);
  };
  const transport = async () => { sends++; return "external-message-id"; };
  const bounded = boundAgentSender(transport, clients.signal);
  const send = (text: string) => { caller.abort(); return bounded("recipient", text); };
  try {
    const pending = mode === "fresh"
      ? deliverGeneratedReply(clients.work, "outbox", { text: "Saved", toolCalls: [] }, send, "owner", clients.settlement)
      : deliverStoredReply(clients.work, "outbox", { text: "Saved", kind: "reply" }, send, "owner", clients.settlement);
    await assertRejects(() => pending);
    assertEquals(sends, 0);
    assertEquals(state, "ready_to_send");
    const retry = boundAgentSender(transport, new AbortController().signal);
    await deliverStoredReply(clients.settlement, "outbox", { text: "Saved", kind: "reply" }, text => retry("recipient", text), "owner", clients.settlement);
    assertEquals(sends, 1);
    assertEquals(state, "sent");
  } finally { globalThis.fetch = original; }
});

for (const failure of ["abort", "network"] as const) Deno.test(`an invoked transport's ${failure} rejection remains unknown delivery`, async () => {
  const original = globalThis.fetch;
  const clients = createAgentClients("https://database.example.test", crypto.randomUUID(), new AbortController().signal);
  let state = "ready_to_send";
  globalThis.fetch = async (_url, init) => {
    const args = JSON.parse(String(init?.body));
    assertEquals(args.p_from, state);
    state = args.p_to;
    return Response.json(true);
  };
  const send = boundAgentSender(async () => {
    throw failure === "abort" ? new DOMException("transport aborted", "AbortError") : new Error("network failed");
  }, clients.signal);
  try {
    await assertRejects(() => deliverStoredReply(clients.work, "outbox", { text: "Saved", kind: "reply" },
      text => send("recipient", text), "owner", clients.settlement));
    assertEquals(state, "delivery_unknown");
  } finally { globalThis.fetch = original; }
});

for (const stalled of ["endpoint", "key"] as const) Deno.test(`cancelled Agent round never dispatches API inference after late ${stalled} resolution`, async () => {
  clearProviderEndpointCache();
  const original = globalThis.fetch;
  const controller = new AbortController();
  let finish!: () => void;
  const gate = new Promise<void>(resolve => { finish = resolve; });
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let paidCalls = 0;
  let resolverSignal: AbortSignal | undefined;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes("/rest/v1/")) {
      resolverSignal = init?.signal ?? undefined;
      entered();
      // Deliberately ignore cancellation to prove the post-resolution guard.
      await gate;
      return Response.json(stalled === "endpoint"
        ? { api_endpoint: "https://provider.example.test/v1", api_type: "openai", is_active: true }
        : { api_key: crypto.randomUUID() });
    }
    paidCalls++;
    return Response.json({ choices: [{ message: { role: "assistant", content: "Late" } }] });
  };
  try {
    const admin = createClient("https://database.example.test", crypto.randomUUID()) as unknown as AiRoutingAdmin;
    const pending = chatCompletion({ provider: stalled === "endpoint" ? "configured" : "openai", model: payload.model,
      credentialSource: stalled === "endpoint" ? "user" : "platform", apiKey: crypto.randomUUID() }, payload, 1000, admin, undefined, controller.signal);
    const rejected = assertRejects(() => pending);
    await started;
    controller.abort();
    finish();
    await rejected;
    assertEquals(resolverSignal?.aborted, true);
    assertEquals(paidCalls, 0);
  } finally { finish(); globalThis.fetch = original; clearProviderEndpointCache(); }
});

for (const provider of ["openai", "claude"] as const) for (const cancel of ["caller", "timeout"] as const) Deno.test(`Agent ${provider} API ${cancel} cancellation stops an in-flight body read`, async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let dispatched!: () => void;
  const started = new Promise<void>(resolve => { dispatched = resolve; });
  let transportSignal: AbortSignal | undefined;
  let bodyCancelled = false;
  let stream!: ReadableStreamDefaultController<Uint8Array>;
  globalThis.fetch = async (_url, init) => {
    transportSignal = init?.signal ?? undefined;
    dispatched();
    return new Response(new ReadableStream<Uint8Array>({ start(c) { stream = c; }, cancel() { bodyCancelled = true; } }));
  };
  try {
    const pending = chatCompletion({ provider, model: payload.model, credentialSource: "user", apiKey: crypto.randomUUID() }, payload, 100, undefined, undefined, controller.signal);
    const rejected = assertRejects(() => pending);
    await started;
    if (cancel === "caller") controller.abort();
    await rejected;
    assertEquals(transportSignal?.aborted, true);
    await new Promise(resolve => setTimeout(resolve, 0));
    assertEquals(bodyCancelled, true);
  } finally { controller.abort(); if (!bodyCancelled) stream?.close(); globalThis.fetch = original; }
});

Deno.test("shared API fetch honors caller cancellation as well as its timeout", async () => {
  const original = globalThis.fetch;
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  globalThis.fetch = async (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(signal?.reason), { once: true }));
  };
  try {
    const pending = fetchWithTimeout("https://provider.example.test", { signal: controller.signal }, 100);
    const rejected = assertRejects(() => pending);
    controller.abort();
    await rejected;
    assert(signal?.aborted);
    assertEquals(signal?.reason, controller.signal.reason);
  } finally { globalThis.fetch = original; }
});

for (const mode of ["fresh", "stored", "send failed"] as const) Deno.test(`outbox ${mode} settles after the work deadline is cancelled`, async () => {
  const original = globalThis.fetch;
  const caller = new AbortController();
  const clients = createAgentClients("https://database.example.test", crypto.randomUUID(), caller.signal);
  let state = mode === "fresh" ? "running" : "ready_to_send";
  globalThis.fetch = async (_url, init) => {
    init?.signal?.throwIfAborted();
    const args = JSON.parse(String(init?.body));
    assertEquals(args.p_from, state);
    state = args.p_to;
    return Response.json(true);
  };
  const send = async () => {
    caller.abort();
    if (mode === "send failed") throw new Error("external send outcome unknown");
    return "external-message-id";
  };
  try {
    const pending = mode === "fresh"
      ? deliverGeneratedReply(clients.work, "outbox", { text: "Saved reply", toolCalls: [] }, send, "owner", clients.settlement)
      : deliverStoredReply(clients.work, "outbox", { text: "Saved reply", kind: "reply" }, send, "owner", clients.settlement);
    if (mode === "send failed") await assertRejects(() => pending, Error, "external send outcome unknown");
    else assertEquals((await pending).messageId, "external-message-id");
    assertEquals(state, mode === "send failed" ? "delivery_unknown" : "sent");
  } finally { globalThis.fetch = original; }
});

Deno.test("expired settlement cannot consume the reserved lease cleanup budget", async () => {
  const original = globalThis.fetch;
  const caller = new AbortController();
  const clients = createAgentClients("https://database.example.test", crypto.randomUUID(), caller.signal,
    { workMs: 1000, settlementMs: 15, cleanupMs: 1000 });
  const requests: string[] = [];
  globalThis.fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    const name = new URL(String(url)).pathname.split("/").at(-1)!;
    requests.push(name);
    if (name === "settlement_stalls") return await new Promise(() => {});
    return Response.json(true);
  };
  try {
    caller.abort();
    const started = Date.now();
    const stalled = await clients.settlement.rpc("settlement_stalls");
    assert(stalled.error);
    assert(Date.now() - started < 1000);
    const scope = { userId: "owner", platform: "whatsapp", conversationId: "conversation" };
    const lease = { threadId: "thread", marker: "marker", claimToken: "claim", replyDurable: false, released: false };
    await releaseFailedEscalationTurn(clients.cleanup, scope, lease, "outbox", { sideEffectsHappened: false, error: "cancelled" });
    assertEquals(lease.released, true);
    await releaseUnpersistedEscalation(clients.cleanup, scope, lease);
    assert(requests.some(name => name.includes("release")));
    assert(requests.some(name => name.includes("advance_agent_reply")));
  } finally { globalThis.fetch = original; }
});

Deno.test("an uncooperative delivery cannot prevent unknown-outcome settlement and lease cleanup", async () => {
  const original = globalThis.fetch;
  const caller = new AbortController();
  const clients = createAgentClients("https://database.example.test", crypto.randomUUID(), caller.signal);
  let state = "ready_to_send";
  let released = false;
  globalThis.fetch = async (url, init) => {
    init?.signal?.throwIfAborted();
    if (String(url).includes("release_unanswered")) released = true;
    else state = JSON.parse(String(init?.body)).p_to;
    return Response.json(true);
  };
  const send = boundAgentSender(async () => {
    caller.abort();
    return await new Promise(() => {});
  }, clients.signal);
  try {
    await assertRejects(() => deliverStoredReply(clients.work, "outbox", { text: "Saved", kind: "reply" },
      text => send("recipient", text), "owner", clients.settlement));
    assertEquals(state, "delivery_unknown");
    await releaseUnpersistedEscalation(clients.cleanup, { userId: "owner", platform: "whatsapp", conversationId: "conversation" },
      { threadId: "thread", marker: "marker", claimToken: "claim", replyDurable: false });
    assertEquals(released, true);
  } finally { globalThis.fetch = original; }
});

// Reliability wiring uses the handler captured above, with all provider and database
// transport replaced. Nothing here can reach a model, connector, or production service.
type FixtureRow = Record<string, unknown>;
type FixtureLog = { metadata?: FixtureRow };

function modelMessages(payload: FixtureRow): FixtureRow[] {
  return Array.isArray(payload.messages) ? payload.messages as FixtureRow[] : [];
}

function nestedField(row: FixtureRow, outer: string, inner: string): unknown {
  const nested = row[outer];
  return nested !== null && typeof nested === "object" && !Array.isArray(nested)
    ? (nested as FixtureRow)[inner]
    : undefined;
}

type FixtureOptions = {
  maxIterations?: number;
  language?: "en" | "ar";
  tools?: FixtureRow[];
  initialMessages?: FixtureRow[];
  failInbound?: boolean;
  failCacheRead?: boolean;
  model: (call: number, payload: FixtureRow) => Response;
  adapter?: (call: number, payload: FixtureRow) => Response | Promise<Response>;
};

function toolCompletion(id: string, args: FixtureRow, second?: { id: string; args: FixtureRow }) {
  const call = (callId: string, callArgs: FixtureRow) => ({
    id: callId,
    type: "function",
    function: { name: "catalog", arguments: JSON.stringify(callArgs) },
  });
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [call(id, args), ...(second ? [call(second.id, second.args)] : [])],
      },
    }],
  });
}

function namedToolCompletion(id: string, name: string, args: FixtureRow) {
  return Response.json({
    choices: [{
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
    }],
  });
}

function textCompletion(text: string | null) {
  return Response.json({ choices: [{ message: { role: "assistant", content: text } }] });
}

async function withReliabilityFixture(
  options: FixtureOptions,
  run: (fixture: {
    request(inboundText: string, outboxId?: string | null): Promise<Response>;
    sandboxRequest(inboundText: string): Promise<Response>;
    advance(ms: number): void;
    modelPayloads: FixtureRow[];
    adapterPayloads: FixtureRow[];
    messageRows: FixtureRow[];
    sent: string[];
    systemLogs: FixtureLog[];
    historyQueries: URL[];
    prepareRedelivery(id: string, text: string): void;
    state(): string;
  }) => Promise<void>,
) {
  const originalFetch = globalThis.fetch;
  const originalNow = Date.now;
  const savedEnv = ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"].map((name) => [name, Deno.env.get(name)] as const);
  const serviceKey = crypto.randomUUID();
  Deno.env.set("SUPABASE_URL", "https://database.example.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", serviceKey);
  Deno.env.set("SUPABASE_ANON_KEY", "sandbox-anon-key");
  let now = originalNow();
  Date.now = () => now;
  const outboxStates = new Map<string, string>();
  const outboxReplies = new Map<string, { text: string; toolCalls: unknown[] }>();
  const outboxId = "10000000-0000-4000-8000-000000000001";
  const owner = "owner";
  const threadId = "thread";
  const modelPayloads: FixtureRow[] = [];
  const adapterPayloads: FixtureRow[] = [];
  const messageRows: FixtureRow[] = (options.initialMessages ?? []).map((row) => ({ ...row }));
  const sent: string[] = [];
  const systemLogs: FixtureLog[] = [];
  const historyQueries: URL[] = [];
  const account = {
    id: "account",
    user_id: owner,
    platform: "whatsapp",
    platform_user_id: "phone",
    access_token: crypto.randomUUID(),
    connection_mode: "cloud_api",
    account_metadata: {},
  };
  const catalog = {
    id: "catalog-tool",
    name: "catalog",
    description: "Read the product catalog",
    url: "https://connector.example.test",
    secret: null,
    admin_only: false,
    scope: "all_accounts",
    social_account_id: null,
    connector_type: "woocommerce",
    read_only_mode: true,
    settings: {},
    auth_strategy: "manual_credentials",
    connection_id: null,
  };

  globalThis.fetch = async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(input instanceof Request ? input.url : String(input));
    const rawBody = init?.body !== undefined
      ? String(init.body)
      : input instanceof Request
      ? await input.clone().text()
      : "";
    const args: FixtureRow = rawBody ? JSON.parse(rawBody) : {};
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    const table = url.pathname.startsWith("/rest/v1/") ? url.pathname.split("/").at(-1)! : "";

    if (url.pathname.endsWith("/auth/v1/user")) {
      return Response.json({ id: owner, aud: "authenticated", role: "authenticated" });
    }
    if (url.pathname.includes("/rpc/") && url.pathname.includes("rate_limit")) {
      return Response.json({ allowed: true, count: 0, remaining: 60, retry_after: 0 });
    }
    if (url.pathname.endsWith("/chat/completions")) {
      modelPayloads.push(args);
      return options.model(modelPayloads.length, args);
    }
    if (url.pathname.endsWith("/functions/v1/ai-agent-adapters")) {
      adapterPayloads.push(args);
      return options.adapter?.(adapterPayloads.length, args) ?? Response.json({ ok: true, data: [] });
    }
    if (url.pathname.endsWith("/messages") && !table) {
      sent.push(String(nestedField(args, "text", "body") ?? nestedField(args, "message", "text") ?? args.text ?? ""));
      return Response.json({ messages: [{ id: `external-${sent.length}` }] });
    }
    if (url.pathname.includes("/rpc/")) {
      if (args.p_from) {
        const id = String(args.p_id ?? outboxId);
        if (args.p_from !== (outboxStates.get(id) ?? "pending")) return Response.json(false);
        outboxStates.set(id, String(args.p_to));
        return Response.json(true);
      }
      return Response.json([]);
    }
    if (table === "ai_thread_messages") {
      if (method === "POST") {
        const rows = Array.isArray(args) ? args : [args];
        for (const row of rows) {
          if (row.role === "user" && options.failInbound) {
            return Response.json({ code: "500", message: "storage unavailable" }, { status: 500 });
          }
          if (messageRows.some((existing) => existing.id === row.id)) {
            return Response.json({ code: "23505", message: "duplicate" }, { status: 409 });
          }
          messageRows.push({ id: crypto.randomUUID(), created_at: new Date(now).toISOString(), ...row });
        }
        return Response.json(null);
      }
      const filters = (column: string) => url.searchParams.get(column);
      if (filters("id")?.startsWith("eq.")) {
        const id = filters("id")!.slice(3);
        const row = messageRows.find((candidate) =>
          candidate.id === id &&
          (!filters("thread_id") || filters("thread_id") === `eq.${candidate.thread_id}`) &&
          (!filters("user_id") || filters("user_id") === `eq.${candidate.user_id}`)
        );
        return Response.json(row ?? null);
      }
      historyQueries.push(url);
      const excluded = filters("id")?.startsWith("neq.") ? filters("id")!.slice(4) : null;
      const rows = messageRows.filter((row) =>
        row.id !== excluded && row.thread_id === threadId && ["user", "assistant"].includes(String(row.role))
      ).sort((left, right) =>
        Date.parse(String(right.created_at)) - Date.parse(String(left.created_at)) || String(left.role).localeCompare(String(right.role))
      );
      const limit = Number(url.searchParams.get("limit") ?? rows.length);
      return Response.json(rows.slice(0, limit), { headers: { "content-range": `0-${Math.max(0, rows.length - 1)}/${rows.length}` } });
    }
    if (table === "ai_threads") {
      if (method === "POST") return Response.json({ id: threadId, user_id: owner, customer_language: null });
      if (method === "PATCH") return Response.json(null);
      return Response.json({ id: threadId, user_id: owner, customer_language: null, unanswered_escalation_since: null });
    }
    if (table === "pending_agent_replies") {
      const requestedId = url.searchParams.get("id")?.replace(/^eq\./, "") ?? outboxId;
      const stored = outboxReplies.get(requestedId);
      const row = {
        id: requestedId,
        user_id: owner,
        status: outboxStates.get(requestedId) ?? "pending",
        generated_reply: stored?.text ?? null,
        generated_tool_calls: stored?.toolCalls ?? null,
        generated_kind: null,
      };
      const matches = !url.searchParams.get("user_id") || url.searchParams.get("user_id") === `eq.${owner}`;
      return Response.json(matches ? row : null);
    }
    if (table === "social_accounts") return Response.json(account);
    if (table === "ai_agent_configs") {
      return Response.json({
        is_enabled: true,
        default_mode: "ai_first",
        reply_cooldown_seconds: 0,
        daily_message_cap: 0,
        language_mode: options.language ?? "en",
        max_tool_iterations: options.maxIterations ?? 5,
        admin_phone_numbers: [],
        handoff_on_request: true,
        handoff_on_low_confidence: true,
      });
    }
    if (table === "system_settings") {
      return Response.json([{
        key: "default_ai_model_agent",
        value: { provider_code: "openai", model_id: "configured-model" },
      }]);
    }
    if (table === "provider_api_keys") return Response.json({ api_key: serviceKey });
    if (table === "ai_agent_tools") return Response.json(options.tools ?? [catalog]);
    if (table === "ai_agent_tool_accounts") return Response.json([]);
    if (table === "messaging_cache") {
      return options.failCacheRead
        ? Response.json({ message: "cache read failed" }, { status: 500 })
        : Response.json(null);
    }
    if (table === "whatsapp_messages" && method === "GET") {
      return Response.json({ timestamp: new Date(now).toISOString() });
    }
    if (table === "system_logs" && method === "POST") systemLogs.push(args);
    if (["ai_conversation_modes", "whatsapp_conversation_assignments", "whatsapp_agents"].includes(table)) {
      return Response.json(table === "whatsapp_agents" ? [] : null);
    }
    if (["app_settings", "user_feature_overrides", "user_ai_routing_preferences"].includes(table)) {
      return Response.json(null);
    }
    return Response.json([], { headers: { "content-range": "0-0/0" } });
  };

  const request = (inboundText: string, id: string | null = outboxId) => handleReply(new Request("https://function.example.test", {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: owner,
      platform: "whatsapp",
      social_account_id: "account",
      conversation_id: "conversation",
      phone_number_id: "phone",
      recipient_phone: "recipient",
      inbound_text: inboundText,
      ...(id ? { outbox_id: id } : {}),
    }),
  }));
  const sandboxRequest = (inboundText: string) => handleReply(new Request("https://function.example.test", {
    method: "POST",
    headers: { Authorization: "Bearer sandbox-token", "Content-Type": "application/json" },
    body: JSON.stringify({ platform: "whatsapp", social_account_id: "account", inbound_text: inboundText }),
  }));
  try {
    await run({
      request,
      sandboxRequest,
      advance: (ms) => { now += ms; },
      modelPayloads,
      adapterPayloads,
      messageRows,
      sent,
      systemLogs,
      historyQueries,
      prepareRedelivery: (id, text) => {
        outboxStates.set(id, "ready_to_send");
        outboxReplies.set(id, { text, toolCalls: [{ name: "catalog", arguments: { capability: "search_products" } }] });
      },
      state: () => outboxStates.get(outboxId) ?? "pending",
    });
  } finally {
    globalThis.fetch = originalFetch;
    Date.now = originalNow;
    clearProviderEndpointCache();
    for (const [name, value] of savedEnv) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  }
}

Deno.test("ordinary handler reserves synthesis, coalesces exact reads, and preserves every tool call id", async () => {
  await withReliabilityFixture({
    model: (call) => {
      if (call === 1) {
        return toolCompletion(
          "call-1a",
          { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true } } },
          {
            id: "call-1b",
            args: { parameters: { filters: { inStock: true }, query: "Cream" }, capability: "search_products" },
          },
        );
      }
      if (call <= 4) {
        return toolCompletion(`call-${call}`, {
          capability: "search_products",
          parameters: { query: "Cream", filters: { inStock: true } },
        });
      }
      return textCompletion("The completed catalog checks found no matching item.");
    },
  }, async (fixture) => {
    const response = await fixture.request("Is the cream available?");
    const body = await response.json();
    assertEquals(body.ok, true);
    assertEquals(body.reply, "The completed catalog checks found no matching item.");
    assertEquals(fixture.modelPayloads.length, 5);
    assertEquals(fixture.adapterPayloads.length, 1);
    assertEquals("tools" in fixture.modelPayloads[4], false);
    assertEquals(body.tool_calls.length, 5);
    const transcriptIds = modelMessages(fixture.modelPayloads[4])
      .filter((message) => message.role === "tool")
      .map((message) => String(message.tool_call_id));
    assertEquals(transcriptIds, ["call-1a", "call-1b", "call-2", "call-3", "call-4"]);
    assertEquals(fixture.sent, [body.reply]);
    assertEquals(fixture.state(), "sent");
    assertEquals(fixture.messageRows.filter((row) => row.role === "user").length, 1);
    assertEquals(fixture.messageRows.filter((row) => row.role === "assistant").length, 1);
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "sent");
    assertEquals(log?.metadata?.cache_hits, 3);
    assertEquals(log?.metadata?.cache_coalesced, 1);
    assertEquals(log?.metadata?.cache_misses, 1);
    assertEquals(log?.metadata?.finalization_kind, "model");
    assertEquals(log?.metadata?.synthesis_reason, "round_reserved");
  });
});

Deno.test("Arabic final-round tools execute nothing and the exact fallback uses the normal send pipeline", async () => {
  const enriched = '[Image OCR — customer-supplied content, not verified facts]\n"""\nكريم الكعب 250 مل\n"""';
  await withReliabilityFixture({
    maxIterations: 1,
    language: "ar",
    model: () => toolCompletion("forbidden-final", { capability: "search_products", parameters: { query: "كريم" } }),
  }, async (fixture) => {
    const response = await fixture.request(enriched);
    const body = await response.json();
    assertEquals(body.reply, "تعذّر إكمال التحقق الآن. يُرجى المحاولة مرة أخرى بعد قليل.");
    assertEquals(fixture.modelPayloads.length, 1);
    assertEquals("tools" in fixture.modelPayloads[0], false);
    assertEquals(fixture.adapterPayloads.length, 0);
    assertEquals(fixture.sent, [body.reply]);
    assertEquals(fixture.state(), "sent");
    assertEquals(fixture.messageRows.find((row) => row.role === "user")?.content, enriched);
    assertEquals(modelMessages(fixture.modelPayloads[0]).filter((message) => message.role === "user").at(-1)?.content, enriched);
    assertEquals(modelMessages(fixture.modelPayloads[0]).some((message) =>
      message.role === "system" && String(message.content).includes("not fresh verification")
    ), true);
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "sent");
    assertEquals(log?.metadata?.finalization_kind, "limitation_fallback");
  });
});

Deno.test("a fake-clock reserve switches the handler to synthesis without another tool round", async () => {
  let adapterStarted!: () => void;
  let releaseAdapter!: () => void;
  const started = new Promise<void>((resolve) => { adapterStarted = resolve; });
  const gate = new Promise<void>((resolve) => { releaseAdapter = resolve; });
  await withReliabilityFixture({
    model: (call) => call === 1
      ? toolCompletion("only-read", { capability: "search_products", parameters: { query: "Cream" } })
      : textCompletion("The catalog returned no matching item."),
    adapter: async () => {
      adapterStarted();
      await gate;
      return Response.json({ ok: true, data: [] });
    },
  }, async (fixture) => {
    const responsePromise = fixture.request("Is it available?");
    await started;
    fixture.advance(36_000);
    releaseAdapter();
    const body = await (await responsePromise).json();
    assertEquals(body.ok, true);
    assertEquals(fixture.modelPayloads.length, 2);
    assertEquals("tools" in fixture.modelPayloads[1], false);
    assertEquals(fixture.adapterPayloads.length, 1);
    assertEquals(fixture.sent, [body.reply]);
  });
});

Deno.test("an inbound prewrite failure starts no model or send and releases outbox work for retry", async () => {
  await withReliabilityFixture({
    failInbound: true,
    model: () => textCompletion("must not run"),
  }, async (fixture) => {
    const body = await (await fixture.request("Keep my question")).json();
    assertEquals(body.ok, false);
    assertEquals(body.error, "inbound_turn_insert_failed");
    assertEquals(fixture.modelPayloads.length, 0);
    assertEquals(fixture.adapterPayloads.length, 0);
    assertEquals(fixture.sent.length, 0);
    assertEquals(fixture.state(), "pending");
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "error");
    assertEquals(log?.metadata?.inbound_persist_status, "failed");
  });
});

Deno.test("a collision in another tenant fails closed before generation", async () => {
  const outboxId = "10000000-0000-4000-8000-000000000001";
  await withReliabilityFixture({
    initialMessages: [{
      id: outboxId,
      thread_id: "thread",
      user_id: "another-owner",
      role: "user",
      content: "unrelated customer text",
    }],
    model: () => textCompletion("must not run"),
  }, async (fixture) => {
    const body = await (await fixture.request("Keep my question")).json();
    assertEquals(body.error, "inbound_turn_collision");
    assertEquals(fixture.modelPayloads.length, 0);
    assertEquals(fixture.sent.length, 0);
    assertEquals(fixture.state(), "pending");
    assertEquals(fixture.messageRows.length, 1);
  });
});

Deno.test("a failed turn retains its question for the followup prompt exactly once", async () => {
  const secondId = "20000000-0000-4000-8000-000000000002";
  const options: FixtureOptions = {
    failCacheRead: true,
    model: () => textCompletion("The earlier question is available in context."),
  };
  await withReliabilityFixture(options, async (fixture) => {
    const failed = await (await fixture.request("Do you have the 250 ml cream?")).json();
    assertEquals(failed.ok, false);
    assertEquals(fixture.modelPayloads.length, 0);
    assertEquals(fixture.state(), "pending");

    // The followup is a new event, not a deduplication of equal text.
    options.failCacheRead = false;
    const response = await fixture.request("You did not answer", secondId);
    assertEquals((await response.json()).ok, true);
    assertEquals(fixture.messageRows.filter((row) => row.role === "user").length, 2);
    assertEquals(fixture.historyQueries.at(-1)?.searchParams.get("id"), `neq.${secondId}`);
    const promptUsers = modelMessages(fixture.modelPayloads[0])
      .filter((message) => message.role === "user")
      .map((message) => String(message.content));
    assertEquals(promptUsers.filter((content: string) => content === "Do you have the 250 ml cream?").length, 1);
    assertEquals(promptUsers.filter((content: string) => content === "You did not answer").length, 1);
  });
});

Deno.test("blank synthesis selects the honest fallback instead of cancelling as no_reply_generated", async () => {
  await withReliabilityFixture({
    maxIterations: 1,
    model: () => textCompletion("  "),
  }, async (fixture) => {
    const body = await (await fixture.request("Please verify this")).json();
    assertEquals(body.reply, "I couldn’t complete verification just now. Please try again shortly.");
    assertEquals(body.skipped, undefined);
    assertEquals(fixture.sent, [body.reply]);
    assertEquals(fixture.state(), "sent");
  });
});

Deno.test("direct non-outbox calls use only invocation-local inbound identity", async () => {
  await withReliabilityFixture({
    maxIterations: 1,
    model: () => textCompletion("A direct response."),
  }, async (fixture) => {
    for (let call = 0; call < 2; call++) {
      const body = await (await fixture.request("Same words", null)).json();
      assertEquals(body.ok, true);
    }
    const users = fixture.messageRows.filter((row) => row.role === "user");
    assertEquals(users.length, 2);
    assertEquals(new Set(users.map((row) => row.id)).size, 2);
    assertEquals(fixture.modelPayloads.length, 2);
    assertEquals(fixture.sent, ["A direct response.", "A direct response."]);
  });
});

Deno.test("sandbox turns prewrite with invocation identity and never send externally", async () => {
  await withReliabilityFixture({
    maxIterations: 1,
    model: () => textCompletion("Sandbox response."),
  }, async (fixture) => {
    for (let call = 0; call < 2; call++) {
      const body = await (await fixture.sandboxRequest("Same sandbox question")).json();
      assertEquals(body.ok, true);
      assertEquals(body.reply, "Sandbox response.");
    }
    const users = fixture.messageRows.filter((row) => row.role === "user");
    assertEquals(users.length, 2);
    assertEquals(new Set(users.map((row) => row.id)).size, 2);
    assertEquals(fixture.sent.length, 0);
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "test");
    assert(["inserted", "verified"].includes(String(log?.metadata?.inbound_persist_status)));
  });
});


Deno.test("an adapter failure is not cached and the next model round retries the read", async () => {
  await withReliabilityFixture({
    model: (call) => {
      if (call <= 2) {
        return toolCompletion(`retry-${call}`, {
          capability: "search_products",
          parameters: { query: "Cream", filters: { inStock: true } },
        });
      }
      return textCompletion("The retry succeeded and returned no matching items.");
    },
    adapter: (call) => call === 1
      ? Response.json({ ok: false, error: { message: "temporary adapter failure" } })
      : Response.json({ ok: true, data: [] }),
  }, async (fixture) => {
    const body = await (await fixture.request("Please check the cream")).json();
    assertEquals(body.ok, true);
    assertEquals(fixture.adapterPayloads.length, 2);
    assertEquals(fixture.modelPayloads.length, 3);
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "sent");
    assertEquals(log?.metadata?.cache_misses, 2);
    assertEquals(log?.metadata?.cache_errors, 1);
    assertEquals(log?.metadata?.cache_hits, 0);
  });
});

Deno.test("a potentially mutating action invalidates an earlier successful read", async () => {
  const args = { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true } } };
  await withReliabilityFixture({
    model: (call) => {
      if (call === 1) return toolCompletion("before-action", args);
      if (call === 2) return namedToolCompletion("action", "escalate_to_human", { reason: "Customer asked for a person" });
      if (call === 3) return toolCompletion("after-action", args);
      return textCompletion("The catalog was checked again after the handoff.");
    },
  }, async (fixture) => {
    const body = await (await fixture.request("Check this and connect me to a person")).json();
    assertEquals(body.ok, true);
    assertEquals(body.escalated, true);
    assertEquals(fixture.adapterPayloads.length, 2);
    assertEquals(fixture.sent, [body.reply]);
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "sent");
    assertEquals(log?.metadata?.cache_misses, 2);
    assertEquals(log?.metadata?.cache_hits, 0);
  });
});


Deno.test("a non-read-only connector with a native tool name invalidates cached reads", async () => {
  const args = { capability: "search_products", parameters: { query: "Cream" } };
  const tool = (name: string, readOnly: boolean): FixtureRow => ({
    id: name,
    name,
    description: name,
    url: "https://connector.example.test",
    secret: null,
    admin_only: false,
    scope: "all_accounts",
    connector_type: "supabase",
    read_only_mode: readOnly,
  });
  await withReliabilityFixture({
    tools: [tool("catalog", true), tool("search_knowledge", false)],
    model: (call) => {
      if (call === 1) return toolCompletion("before", args);
      if (call === 2) return namedToolCompletion("custom", "search_knowledge", args);
      if (call === 3) return toolCompletion("after", args);
      return textCompletion("The catalog was checked again.");
    },
  }, async (fixture) => {
    const body = await (await fixture.request("Check the current catalog")).json();
    assertEquals(body.ok, true);
    assertEquals(fixture.adapterPayloads.map((payload) => payload.tool_id), ["catalog", "search_knowledge", "catalog"]);
    assertEquals(fixture.sent, [body.reply]);
  });
});

Deno.test("a provider failure during reserved synthesis remains owned by the outage floor", async () => {
  await withReliabilityFixture({
    maxIterations: 1,
    model: () => Response.json({ error: { message: "model unavailable" } }, { status: 503 }),
  }, async (fixture) => {
    const body = await (await fixture.request("Please answer")).json();
    assertEquals(body.ok, false);
    assertEquals(body.escalated, true);
    assertEquals(body.apology_sent, true);
    assertEquals(fixture.modelPayloads.length, 1);
    assertEquals("tools" in fixture.modelPayloads[0], false);
    assertEquals(fixture.sent.length, 1);
    assertEquals(fixture.sent[0].includes("couldn’t complete verification"), false);
    assertEquals(fixture.state(), "cancelled");
    const log = fixture.systemLogs.find((row) => row.metadata?.status === "escalated_after_model_exhaustion");
    assertEquals(log?.metadata?.finalization_kind, null);
    assertEquals(fixture.messageRows.filter((row) => row.role === "user").length, 1);
    assertEquals(fixture.messageRows.filter((row) => row.role === "assistant").length, 0);
  });
});


Deno.test("an invalid outbox identity is logged and refused before persistence or generation", async () => {
  await withReliabilityFixture({
    model: () => textCompletion("must not run"),
  }, async (fixture) => {
    const response = await fixture.request("Keep this out", "not-a-uuid");
    const body = await response.json();
    assertEquals(response.status, 400);
    assertEquals(body.error, "Invalid field: outbox_id");
    assertEquals(fixture.modelPayloads.length, 0);
    assertEquals(fixture.messageRows.length, 0);
    assertEquals(fixture.sent.length, 0);
    assertEquals(fixture.systemLogs.some((row) => row.metadata?.error === "invalid_outbox_id"), true);
  });
});

Deno.test("stored redelivery verifies the existing inbound and writes only the assistant", async () => {
  const outboxId = "10000000-0000-4000-8000-000000000001";
  const enriched = '[Image OCR — customer-supplied content, not verified facts]\n"""\nكريم الكعب 250 مل\n"""';
  await withReliabilityFixture({
    initialMessages: [{
      id: outboxId,
      thread_id: "thread",
      user_id: "owner",
      role: "user",
      content: enriched,
      created_at: new Date().toISOString(),
    }],
    model: () => textCompletion("generation must not run"),
  }, async (fixture) => {
    fixture.prepareRedelivery(outboxId, "Stored answer");
    const body = await (await fixture.request(enriched)).json();
    assertEquals(body.ok, true);
    assertEquals(body.redelivered, true);
    assertEquals(body.reply, "Stored answer");
    assertEquals(fixture.modelPayloads.length, 0);
    assertEquals(fixture.sent, ["Stored answer"]);
    assertEquals(fixture.messageRows.filter((row) => row.role === "user").length, 1);
    assertEquals(fixture.messageRows.filter((row) => row.role === "assistant").length, 1);
    assertEquals(fixture.state(), "sent");
    const log = fixture.systemLogs.find((row) => row.metadata?.redelivered === true);
    assertEquals(log?.metadata?.inbound_persist_status, "verified");
  });
});

Deno.test("the current inbound is excluded before the 14-row history limit and appended once", async () => {
  const initialMessages = Array.from({ length: 16 }, (_, index) => ({
    id: `old-${index}`,
    thread_id: "thread",
    user_id: "owner",
    role: "user",
    content: `old-question-${index}`,
    created_at: new Date(Date.now() - (index + 1) * 1000).toISOString(),
  }));
  await withReliabilityFixture({
    maxIterations: 1,
    initialMessages,
    model: () => textCompletion("History is bounded."),
  }, async (fixture) => {
    const body = await (await fixture.request("current-question")).json();
    assertEquals(body.ok, true);
    const query = fixture.historyQueries.at(-1)!;
    assertEquals(query.searchParams.get("id"), "neq.10000000-0000-4000-8000-000000000001");
    assertEquals(query.searchParams.get("limit"), "14");
    const promptUsers = modelMessages(fixture.modelPayloads[0])
      .filter((message) => message.role === "user")
      .map((message) => String(message.content));
    assertEquals(promptUsers.length, 15);
    assertEquals(promptUsers.at(-1), "current-question");
    assertEquals(promptUsers.includes("old-question-0"), true);
    assertEquals(promptUsers.includes("old-question-13"), true);
    assertEquals(promptUsers.includes("old-question-14"), false);
    assertEquals(promptUsers.includes("old-question-15"), false);
    assertEquals(promptUsers.filter((content: string) => content === "current-question").length, 1);
  });
});
