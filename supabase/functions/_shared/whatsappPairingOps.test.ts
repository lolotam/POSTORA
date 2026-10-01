// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { DIRECT_QR_CONSENT_VERSION, endSession, historySyncStatus, pairingStatus, registerNumber, startHistorySync, startPairing } from "./whatsappPairingOps.ts";
import { WhatsAppOpError } from "./whatsappPartnerOps.ts";
import { createEvolutionApi, EvolutionApiError } from "./evolutionApi.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const CONSENT = { accepted: true, accepted_by: "tenant-admin@example.com", accepted_at: "2026-09-10T09:00:00Z", accepted_ip: "203.0.113.9" };
const INPUT = { connection_name: "Support", connection_mode: "evolution_qr", risk_consent: CONSENT };
const CTX = { workspaceId: "ws-1", keyId: "key-1", accountIds: [ID], requestId: "req-1" };

for (const [label, risk_consent] of Object.entries({
  missing: undefined, unaccepted: { ...CONSENT, accepted: false },
  identity_missing: { accepted: true, accepted_at: CONSENT.accepted_at },
  identity_empty: { ...CONSENT, accepted_by: " " },
  timestamp_missing: { accepted: true, accepted_by: CONSENT.accepted_by },
  timestamp_invalid: { ...CONSENT, accepted_at: "nonsense" },
  malformed: "true", ip_invalid: { ...CONSENT, accepted_ip: 42 },
})) {
  Deno.test(`registration refuses ${label} consent without a write`, async () => {
    const result = await registerNumber({ ...CTX, admin: {} }, { ...INPUT, risk_consent });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "invalid_request");
  });
}

for (const connection_name of ["", " ", "x".repeat(61), 5]) {
  Deno.test(`registration rejects invalid name ${JSON.stringify(connection_name)}`, async () => {
    const result = await registerNumber({ ...CTX, admin: {} }, { ...INPUT, connection_name });
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.reason, "invalid_request");
  });
}

Deno.test("registration passes the attestation and version to the atomic RPC", async () => {
  const calls: Record<string, unknown>[] = [];
  const admin = { rpc: (name: string, args: Record<string, unknown>) => {
    assertEquals(name, "register_partner_whatsapp_number");
    calls.push(args);
    return Promise.resolve({ data: { account_id: ID }, error: null });
  } };
  for (const name of ["x", "x".repeat(60)]) {
    assertEquals(await registerNumber({ ...CTX, admin }, { ...INPUT, connection_name: ` ${name} ` }), { ok: true, accountId: ID });
    assertEquals(calls.at(-1), {
      p_key_id: CTX.keyId, p_workspace_id: CTX.workspaceId, p_connection_name: name,
      p_risk_consent_accepted_by: CONSENT.accepted_by, p_risk_consent_accepted_at: "2026-09-10T09:00:00.000Z",
      p_risk_consent_accepted_ip: CONSENT.accepted_ip, p_consent_version: DIRECT_QR_CONSENT_VERSION, p_request_id: CTX.requestId,
    });
  }
});

for (const operation of [startPairing, pairingStatus, endSession, historySyncStatus, startHistorySync]) {
  Deno.test(`${operation.name} refuses an unbound account before any query`, async () => {
    await assertRejects(() => operation({ ...CTX, admin: {} }, "foreign-account"), WhatsAppOpError, "Number not found");
  });
}

for (const mode of ["cloud_api", "coexistence"]) {
  Deno.test(`session end refuses ${mode} without teardown`, async () => {
    const db = fixture({ mode });
    const error = await assertRejects(() => endSession({ ...CTX, admin: db.admin }, ID), WhatsAppOpError);
    assertEquals(error.code, "unsupported_capability");
    assertEquals(db.calls.length, 1);
  });
}

Deno.test("session teardown preserves local success when Evolution is unreachable", async () => {
  const db = fixture({ existing: true });
  const result = await endSession({ ...CTX, admin: db.admin }, ID, { evolution: {
    logout: () => Promise.reject(new Error("secret https://private-host")),
    deleteInstance: () => Promise.reject(new Error("secret provider token")),
  } });
  assertEquals(result.local_deactivated, true);
  assertEquals(result.remote_logout, "failed");
  assertEquals(result.warnings.length, 2);
  assert(!JSON.stringify(result).includes("secret"));
  const update = db.calls.at(-1)!;
  assertEquals(update.body, { is_active: false });
  assertEquals(update.url.searchParams.get("workspace_id"), "eq.ws-1");
  assertEquals(update.url.searchParams.get("id"), `eq.${ID}`);
});

Deno.test("session with no remote instance reports skipped and a warning", async () => {
  const db = fixture();
  const result = await endSession({ ...CTX, admin: db.admin }, ID);
  assertEquals(result.remote_logout, "skipped");
  assertEquals(result.local_deactivated, true);
  assert(result.warnings.length > 0);
});

const FINISHED = "2026-09-10T10:00:00Z";
const COMPLETE_OUTCOME = { chatsDiscovered: 1, chatsImported: 1, chatsSkipped: 0,
  chatsAwaitingLid: 0, chatsLidResolved: 0, messagesWritten: 2, chatFailures: 0,
  truncated: false, finished_at: FINISHED };

for (const [label, outcome, started, lastSync, state] of [
  ["never started", null, null, null, "idle"],
  ["lease held", { error: "previous failure" }, FINISHED, null, "running"],
  ["legacy completion", null, null, FINISHED, "completed"],
  ["clean sweep", COMPLETE_OUTCOME, null, FINISHED, "completed"],
  ["truncated", { ...COMPLETE_OUTCOME, truncated: true }, null, FINISHED, "partial"],
  ["chat failures", { ...COMPLETE_OUTCOME, chatFailures: 1 }, null, FINISHED, "partial"],
  ["unresolved LIDs", { ...COMPLETE_OUTCOME, chatsAwaitingLid: 1 }, null, FINISHED, "partial"],
  ["warming messages", { ...COMPLETE_OUTCOME, messagesWritten: 0 }, null, FINISHED, "partial"],
  ["empty discovery", { ...COMPLETE_OUTCOME, chatsDiscovered: 0, chatsImported: 0, messagesWritten: 0 }, null, null, "partial"],
  ["worker exception", { error: "The import stopped unexpectedly. Try again in a minute.", finished_at: FINISHED }, null, "2026-09-01T00:00:00Z", "failed"],
] as const) {
  Deno.test(`history status maps ${label} from the instance row`, async () => {
    const calls: string[] = [];
    const admin = { from(table: string) {
      calls.push(table);
      return { select() { return this; }, eq() { return this; }, maybeSingle() {
        return Promise.resolve({ data: table === "social_accounts" ? { id: ID, connection_mode: "evolution_qr" } :
          { sync_started_at: started, last_sync_at: lastSync, last_sync_outcome: outcome }, error: null });
      } };
    } };
    const result = await historySyncStatus({ ...CTX, admin }, ID);
    assertEquals(result.state, state);
    assertEquals(result.started_at, started);
    assertEquals(result.finished_at, outcome && "finished_at" in outcome ? outcome.finished_at : lastSync);
    assertEquals(calls, ["social_accounts", "whatsapp_evolution_instances"]);
  });
}

for (const [data, error, expected] of [
  [null, { message: "private database failure" }, "internal_error"],
  [null, null, "resource_not_found"],
  [{ sync_started_at: null, last_sync_at: FINISHED, last_sync_outcome: { status: "future-value" } }, null, "internal_error"],
] as const) {
  Deno.test(`history status refuses ${JSON.stringify({ data, error })}`, async () => {
    const admin = { from(table: string) {
      return { select() { return this; }, eq() { return this; }, maybeSingle() {
        return Promise.resolve(table === "social_accounts" ? { data: { connection_mode: "evolution_qr" }, error: null } : { data, error });
      } };
    } };
    const caught = await assertRejects(() => historySyncStatus({ ...CTX, admin }, ID), WhatsAppOpError);
    assertEquals(caught.code, expected);
    assert(!caught.message.includes("private"));
  });
}

function fixture(options: { existing?: boolean; active?: boolean; resolved?: boolean; failTable?: string; mode?: string; leaseHeld?: boolean; noWorkspace?: boolean; metadata?: Record<string, unknown> } = {}) {
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  // Advances per read, standing in for Postgres bumping updated_at on write.
  let accountReads = 0;
  const metadata = { display_name: "Support", risk_consent: CONSENT, arbitrary_marker: "preserve", ...(options.metadata ?? {}) };
  const admin = createClient("https://database.example", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const url = new URL(String(input));
      const table = url.pathname.split("/").at(-1)!;
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) : {};
      calls.push({ url, method, body });
      if (options.failTable === table) return Promise.resolve(Response.json({ code: "57014", message: "private failure" }, { status: 500 }));
      if (table === "activate_evolution_qr_account") return Promise.resolve(Response.json("15550001111"));
      if (table === "claim_whatsapp_history_sync") return Promise.resolve(Response.json(!options.leaseHeld));
      if (table === "partner_webhooks") {
        assertEquals(url.searchParams.get("workspace_id"), "eq.ws-1");
        assertEquals(url.searchParams.get("id"), null);
        return Promise.resolve(Response.json([
          { id: "matching", secret_version: 1, platform: "whatsapp", social_account_id: ID },
          { id: "other-number", secret_version: 1, platform: "whatsapp", social_account_id: "other-account" },
        ]));
      }
      if (table === "partner_webhook_deliveries") return Promise.resolve(Response.json([{ id: "delivery" }]));
      if (method !== "GET") return Promise.resolve(new Response(null, { status: 204 }));
      if (table === "social_accounts") return Promise.resolve(Response.json([{
        id: ID, connection_mode: options.mode ?? "evolution_qr", is_active: options.active ?? false,
        user_id: "owner-from-account", workspace_id: options.noWorkspace ? null : CTX.workspaceId,
        platform_user_id: options.resolved ? "15550001111" : `pending_${ID}`, account_metadata: metadata,
        // Postgres advances this on every write, and the connection emitter
        // keys its occurrence id on it so a poll and a webhook observing the
        // SAME transition deduplicate in the outbox.
        updated_at: `2026-09-10T00:00:0${accountReads++}.000Z`,
      }]));
      assertEquals(table, "whatsapp_evolution_instances");
      return Promise.resolve(Response.json(options.existing ? [{ instance_name: `postora_${ID}`, jwt_key: "stored-secret", last_qr: "old-qr" }] : []));
    } },
  });
  return { admin, calls, metadata };
}

for (const [label, options, expected] of [
  ["claimed", { existing: true, resolved: true }, null],
  ["lease held", { existing: true, resolved: true, leaseHeld: true }, "sync_already_running"],
  ["unresolved", { existing: true }, "unsupported_capability"],
  ["missing workspace", { existing: true, resolved: true, noWorkspace: true }, "internal_error"],
  ["wrong mode", { mode: "cloud_api" }, "unsupported_capability"],
  ["missing instance", { resolved: true }, "resource_not_found"],
  ["account read failed", { failTable: "social_accounts" }, "internal_error"],
  ["instance read failed", { existing: true, failTable: "whatsapp_evolution_instances" }, "internal_error"],
] as const) {
  Deno.test(`history start ${label} reports the engine outcome without a second lease claim`, async () => {
    const db = fixture(options);
    const providerCalls: string[] = [];
    const api = createEvolutionApi((input) => {
      providerCalls.push(String(input));
      return Promise.resolve(Response.json([]));
    }, { baseUrl: "https://evolution.example", apiKey: "test-key" });
    if (expected) {
      const caught = await assertRejects(() => startHistorySync({ ...CTX, admin: db.admin }, ID, { api }), WhatsAppOpError);
      assertEquals(caught.code, expected);
      assertEquals(providerCalls, []);
      assert(!db.calls.some((call) => call.method === "PATCH"));
    } else {
      assertEquals(await startHistorySync({ ...CTX, admin: db.admin }, ID, { api }), { state: "running" });
      assertEquals(providerCalls.length, 2);
      const completion = db.calls.find((call) => call.method === "PATCH" && call.url.pathname.endsWith("/whatsapp_evolution_instances"))!.body;
      assertEquals(completion.sync_started_at, null);
      assertEquals(typeof (completion.last_sync_outcome as Record<string, unknown>).finished_at, "string");
      const delivery = db.calls.find((call) => call.url.pathname.endsWith("/partner_webhook_deliveries"))!.body as unknown as Record<string, unknown>[];
      assertEquals(delivery.length, 1);
      assertEquals(delivery[0].event_type, "history_sync.completed");
    }
    const claims = db.calls.filter((call) => call.url.pathname.endsWith("/claim_whatsapp_history_sync"));
    assertEquals(claims.length, label === "claimed" || label === "lease held" ? 1 : 0);
    for (const call of db.calls.filter((call) => call.url.pathname.endsWith("/social_accounts"))) {
      assertEquals(call.url.searchParams.get("workspace_id"), "eq.ws-1");
      assertEquals(call.url.searchParams.get("id"), `eq.${ID}`);
      assert(!call.url.searchParams.has("user_id"));
    }
  });
}

function provider(state = "connecting") {
  const calls: Array<{ method: string; input: unknown }> = [];
  const api = {
    createInstance: (input: unknown) => { calls.push({ method: "create", input }); return Promise.resolve({}); },
    connect: (input: string) => { calls.push({ method: "connect", input }); return Promise.resolve({ qrcode: { base64: "qr-image" }, instance: { state } }); },
    connectionState: (input: string) => { calls.push({ method: "state", input }); return Promise.resolve({ instance: { state } }); },
    fetchInstance: (input: string) => { calls.push({ method: "identity", input }); return Promise.resolve({ ownerJid: "15550001111@s.whatsapp.net", profileName: "Provider Name" }); },
    logout: (input: string) => { calls.push({ method: "logout", input }); return Promise.resolve({}); },
  };
  return { api, calls };
}

Deno.test("pairing provisions the bridge instance, credential and webhook and persists the QR", async () => {
  const db = fixture();
  const remote = provider();
  const response = await startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api, webhookBaseUrl: "https://api.example/" });
  assertEquals(response, { account_id: ID, qr: { code: "qr-image", expires_at: null }, state: "connecting" });
  const instance = db.calls.find((call) => call.method === "POST")!.body;
  assertEquals(instance.instance_name, `postora_${ID}`);
  assert(/^[A-Za-z0-9_-]{43}$/.test(String(instance.jwt_key)));
  assertEquals(remote.calls, [
    { method: "create", input: { instanceName: `postora_${ID}`, webhook: {
      url: "https://api.example/functions/v1/whatsapp-evolution-webhook", headers: { jwt_key: instance.jwt_key },
      events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    } } }, { method: "connect", input: `postora_${ID}` },
  ]);
  assertEquals(db.calls.at(-1)!.body, { last_qr: "qr-image", last_connection_state: "connecting" });
  assertEquals(db.calls[0].url.searchParams.get("workspace_id"), "eq.ws-1");
  assert(!JSON.stringify(response).includes(String(instance.jwt_key)));
});

Deno.test("pairing refresh keeps an existing instance and its webhook key", async () => {
  const db = fixture({ existing: true });
  const remote = provider();
  await startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api });
  assertEquals(remote.calls.map((call) => call.method), ["connect"]);
  assert(!db.calls.some((call) => call.method === "POST"));
});

Deno.test("a 429 from createInstance removes the reservation and the next attempt creates again", async () => {
  const db = fixture();
  const remote = provider();
  let creates = 0;
  remote.api.createInstance = () => ++creates === 1
    ? Promise.reject(new EvolutionApiError("private rejection", 429, {})) : Promise.resolve({});
  const deps = { api: remote.api, webhookBaseUrl: "https://api.example" };
  await assertRejects(() => startPairing({ ...CTX, admin: db.admin }, ID, deps), WhatsAppOpError);
  assertEquals(db.calls.filter((call) => call.method === "POST").length, 1);
  const deletions = db.calls.filter((call) => call.method === "DELETE");
  assertEquals(deletions.length, 1);
  assertEquals(deletions[0].url.searchParams.get("social_account_id"), `eq.${ID}`);
  assertEquals(deletions[0].url.searchParams.get("instance_name"), `eq.postora_${ID}`);
  await startPairing({ ...CTX, admin: db.admin }, ID, deps);
  assertEquals(creates, 2);
  assertEquals(db.calls.filter((call) => call.method === "POST").length, 2);
});

Deno.test("connect 404 on a known instance recreates and retries once", async () => {
  const db = fixture({ existing: true });
  const remote = provider();
  let connects = 0;
  remote.api.connect = () => ++connects === 1
    ? Promise.reject(new EvolutionApiError("missing", 404, {}))
    : Promise.resolve({ qrcode: { base64: "qr-image" }, instance: { state: "connecting" } });
  await startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api, webhookBaseUrl: "https://api.example" });
  assertEquals(connects, 2);
  assertEquals(remote.calls, [{ method: "create", input: {
    instanceName: `postora_${ID}`, webhook: {
      url: "https://api.example/functions/v1/whatsapp-evolution-webhook", headers: { jwt_key: "stored-secret" },
      events: ["MESSAGES_UPSERT", "MESSAGES_UPDATE", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
    },
  } }]);
  assertEquals(db.calls.some((call) => call.method === "POST"), false);
});

Deno.test("a definite rejection is not a 5xx", async () => {
  const db = fixture({ existing: true });
  const remote = provider();
  remote.api.connect = () => Promise.reject(new EvolutionApiError("private rejection", 400, {}));
  const error = await assertRejects(() => startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api }), WhatsAppOpError);
  assertEquals(error.status, 422);
  assertEquals(error.code, "invalid_request");
  assertEquals(error.indeterminate, false);
});

for (const state of ["open", "close"]) {
  Deno.test(`pairing poll reconciles ${state} through workspace-scoped writes`, async () => {
    const db = fixture({ existing: true, active: state === "close", resolved: state === "close" });
    const remote = provider(state);
    const response = await pairingStatus({ ...CTX, admin: db.admin }, ID, { api: remote.api });
    assertEquals(response, { account_id: ID, state, phone_number: "15550001111" });
    for (const call of db.calls.filter((call) => call.url.pathname.endsWith("/social_accounts"))) {
      assertEquals(call.url.searchParams.get("workspace_id"), "eq.ws-1");
      assert(!call.url.searchParams.has("user_id"));
    }
    if (state === "open") {
      assertEquals(db.calls.find((call) => call.url.pathname.endsWith("/activate_evolution_qr_account"))!.body, { p_account_id: ID, p_owner_number: "15550001111" });
      assert(!db.calls.some((call) => "platform_username" in call.body));
    } else assertEquals(db.calls.find((call) => call.method === "PATCH" && call.url.pathname.endsWith("/social_accounts"))!.body, { is_active: false });
    const delivery = db.calls.find((call) => call.url.pathname.endsWith("/partner_webhook_deliveries"))!.body as unknown as Record<string, unknown>[];
    assertEquals(delivery.length, 1);
    assertEquals(delivery[0].event_type, state === "open" ? "whatsapp_number.connected" : "whatsapp_number.disconnected");
    assertEquals(delivery[0].webhook_id, "matching");
    assertEquals(delivery[0].workspace_id, CTX.workspaceId);
  });
}

Deno.test("pairingStatus on a mismatch returns state number_mismatch and phone_number null, and calls logout once", async () => {
  const db = fixture({ existing: true, resolved: true });
  const remote = provider("open");
  remote.api.fetchInstance = () => Promise.resolve({ ownerJid: "15550002222@s.whatsapp.net", profileName: "Other Name" });
  const response = await pairingStatus({ ...CTX, admin: db.admin }, ID, { api: remote.api });
  assertEquals(response.state, "number_mismatch");
  assertEquals(response.phone_number, null);
  const logouts = remote.calls.filter((c) => c.method === "logout");
  assertEquals(logouts.length, 1);
  assertEquals(logouts[0].input, `postora_${ID}`);
  assertEquals(db.calls.find((call) => call.method === "PATCH" && call.url.pathname.endsWith("/social_accounts"))!.body,
    { is_active: false, account_metadata: { ...db.metadata, number_mismatch: true } });
});

Deno.test("pairingStatus on an account with durable number_mismatch returns state number_mismatch without calling provider connectionState", async () => {
  const db = fixture({ existing: true, resolved: true, metadata: { number_mismatch: true } });
  const remote = provider("open");
  const response = await pairingStatus({ ...CTX, admin: db.admin }, ID, { api: remote.api });
  assertEquals(response, {
    account_id: ID,
    state: "number_mismatch",
    phone_number: null,
  });
  const stateCalls = remote.calls.filter((c) => c.method === "state");
  assertEquals(stateCalls.length, 0);
});

for (const failTable of ["social_accounts", "whatsapp_evolution_instances"]) {
  Deno.test(`pairing refuses a failed ${failTable} read without calling the provider`, async () => {
    const db = fixture({ failTable });
    const remote = provider();
    await assertRejects(() => startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api }), WhatsAppOpError);
    assertEquals(remote.calls, []);
  });
}

for (const [error, indeterminate] of [[new Error("lost response"), true], [new EvolutionApiError("failed", 503, {}), true], [new EvolutionApiError("refused", 400, {}), false]] as const) {
  Deno.test(`pairing distinguishes ${error.message} from a proven provider rejection`, async () => {
    const db = fixture({ existing: true });
    const remote = provider();
    remote.api.connect = () => Promise.reject(error);
    const caught = await assertRejects(() => startPairing({ ...CTX, admin: db.admin }, ID, { api: remote.api }), WhatsAppOpError);
    assertEquals(caught.indeterminate, indeterminate);
  });
}
