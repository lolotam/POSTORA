// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { DIRECT_QR_CONSENT_VERSION, pairingStatus, registerNumber, startPairing } from "./whatsappPairingOps.ts";
import { WhatsAppOpError } from "./whatsappPartnerOps.ts";
import { EvolutionApiError } from "./evolutionApi.ts";

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

for (const operation of [startPairing, pairingStatus]) {
  Deno.test(`${operation.name} refuses an unbound account before any query`, async () => {
    await assertRejects(() => operation({ ...CTX, admin: {} }, "foreign-account"), WhatsAppOpError, "Number not found");
  });
}

function fixture(options: { existing?: boolean; active?: boolean; resolved?: boolean; failTable?: string; mode?: string } = {}) {
  const calls: Array<{ url: URL; method: string; body: Record<string, unknown> }> = [];
  const metadata = { display_name: "Support", risk_consent: CONSENT, arbitrary_marker: "preserve" };
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
      if (method !== "GET") return Promise.resolve(new Response(null, { status: 204 }));
      if (table === "social_accounts") return Promise.resolve(Response.json([{
        id: ID, connection_mode: options.mode ?? "evolution_qr", is_active: options.active ?? false,
        platform_user_id: options.resolved ? "15550001111" : `pending_${ID}`, account_metadata: metadata,
      }]));
      assertEquals(table, "whatsapp_evolution_instances");
      return Promise.resolve(Response.json(options.existing ? [{ instance_name: `postora_${ID}`, jwt_key: "stored-secret", last_qr: "old-qr" }] : []));
    } },
  });
  return { admin, calls, metadata };
}

function provider(state = "connecting") {
  const calls: Array<{ method: string; input: unknown }> = [];
  const api = {
    createInstance: (input: unknown) => { calls.push({ method: "create", input }); return Promise.resolve({}); },
    connect: (input: string) => { calls.push({ method: "connect", input }); return Promise.resolve({ qrcode: { base64: "qr-image" }, instance: { state } }); },
    connectionState: (input: string) => { calls.push({ method: "state", input }); return Promise.resolve({ instance: { state } }); },
    fetchInstance: (input: string) => { calls.push({ method: "identity", input }); return Promise.resolve({ ownerJid: "15550001111@s.whatsapp.net", profileName: "Provider Name" }); },
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
      assertEquals(db.calls.at(-1)!.body, { p_account_id: ID, p_owner_number: "15550001111" });
      assert(!db.calls.some((call) => "platform_username" in call.body));
    } else assertEquals(db.calls.at(-1)!.body, { is_active: false });
  });
}

Deno.test("reconciliation merges mismatch metadata without erasing consent or the chosen name", async () => {
  const db = fixture({ existing: true, resolved: true });
  const remote = provider("open");
  remote.api.fetchInstance = () => Promise.resolve({ ownerJid: "15550002222@s.whatsapp.net", profileName: "Other Name" });
  await pairingStatus({ ...CTX, admin: db.admin }, ID, { api: remote.api });
  assertEquals(db.calls.at(-1)!.body, { is_active: true, account_metadata: { ...db.metadata, number_mismatch: true } });
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
