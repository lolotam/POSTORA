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
        phone_number_id: "phone", recipient_phone: "recipient", inbound_text: "What are your hours?", outbox_id: "outbox" }) }));
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
