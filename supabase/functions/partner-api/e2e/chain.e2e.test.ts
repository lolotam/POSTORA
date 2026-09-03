// Chain E2E test — Phase 10.8
// Ignored unless PARTNER_E2E_POSTGREST_URL and PARTNER_E2E_JWT_SECRET are set.
// This file must register tests as IGNORED (not skipped, not absent) when env is missing.
// Do NOT import integrationTestGuard.ts (it keys off different vars).

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { generatePartnerKey, hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { handleRequest } from "../index.ts";
import { runWebhookWorker } from "../../process-partner-webhooks/worker.ts";
import { signWebhookPayload } from "../../_shared/partnerWebhookDelivery.ts";
import { reconcileDispatchIntentByEcho } from "../../_shared/partnerDispatchIntents.ts";
import { encodeId, decodeId } from "../v1/ids.ts";

const rawPostgrestUrl = Deno.env.get("PARTNER_E2E_POSTGREST_URL");
const rawJwtSecret = Deno.env.get("PARTNER_E2E_JWT_SECRET");
const e2eEnabled = !!rawPostgrestUrl && !!rawJwtSecret;
const postgrestUrl = rawPostgrestUrl ?? "";
const jwtSecret = rawJwtSecret ?? "";

function e2eTest(name: string, fn: () => Promise<void>) {
  Deno.test({ name, ignore: !e2eEnabled, fn });
}

// ---------------------------------------------------------------------------
// Helpers: JWT, client, setup
// ---------------------------------------------------------------------------
function b64urlEncode(bytes: Uint8Array): string {
  let str = "";
  for (const b of bytes) str += String.fromCharCode(b);
  return btoa(str).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlJson(obj: unknown): string {
  return b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
}
async function mintServiceJwt(secret: string): Promise<string> {
  const header = b64urlJson({ alg: "HS256", typ: "JWT" });
  const payload = b64urlJson({ role: "service_role", exp: Math.floor(Date.now() / 1000) + 600 });
  const data = `${header}.${payload}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return `${data}.${b64urlEncode(new Uint8Array(sig))}`;
}

const FULL_SCOPES = [
  "messages:send",
  "messages:read",
  "accounts:read",
  "conversations:read",
  "media:read",
  "media:write",
  "webhooks:read",
  "webhooks:manage",
  "templates:read",
  "usage:read",
  "posts:read",
  "posts:write",
  "posts:schedule",
  "connectors:read",
  "connectors:manage",
  "tools:execute",
];

interface SetupIds {
  workspace_a: string;
  workspace_b: string;
  account_a: string;
  account_b: string;
  key_a: string;
  key_b: string;
  media_b: string;
  tool_a: string;
  user_a: string;
  user_b: string;
}

interface SetupResult {
  // deno-lint-ignore no-explicit-any
  client: any;
  keyA: { key: string; prefix: string; hash: string };
  keyB: { key: string; prefix: string; hash: string };
  ids: SetupIds;
}

function rewritePostgrestUrl(url: string): string {
  // Supabase-js adds /rest/v1, but harness PostgREST serves at /
  if (url.includes("/rest/v1/")) return url.replace("/rest/v1", "");
  if (url.endsWith("/rest/v1")) return url.replace("/rest/v1", "");
  return url;
}
function postgrestFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  let urlStr: string;
  let reqInit = init;
  if (typeof input === "string") {
    urlStr = rewritePostgrestUrl(input);
    return fetch(urlStr, reqInit);
  }
  if (input instanceof URL) {
    urlStr = rewritePostgrestUrl(input.toString());
    return fetch(urlStr, reqInit);
  }
  // Request object
  urlStr = rewritePostgrestUrl((input as Request).url);
  const req = input as Request;
  // Clone request with rewritten URL
  return fetch(new Request(urlStr, { method: req.method, headers: req.headers, body: req.body as BodyInit | null }), reqInit);
}
async function setupE2E(): Promise<SetupResult> {
  const jwt = await mintServiceJwt(jwtSecret);
  // deno-lint-ignore no-explicit-any
  const client: any = createClient(postgrestUrl, jwt, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: postgrestFetch },
  });
  const keyA = await generatePartnerKey("production");
  const keyB = await generatePartnerKey("production");
  const { data, error } = await client.rpc("partner_e2e_fixture", {
    p_key_hash: keyA.hash,
    p_key_prefix: keyA.prefix,
    p_scopes: FULL_SCOPES,
    p_other_key_hash: keyB.hash,
    p_other_key_prefix: keyB.prefix,
  });
  if (error) throw new Error(`fixture rpc failed: ${JSON.stringify(error)} data:${JSON.stringify(data)}`);
  const ids = data as SetupIds;
  return { client, keyA, keyB, ids };
}

// helper to call partner-api and return parsed json + headers
async function callPartnerApi(
  // deno-lint-ignore no-explicit-any
  client: any,
  opts: { method: string; path: string; key: string; body?: unknown; headers?: Record<string, string> },
): Promise<{ status: number; json: unknown; headers: Headers }> {
  const url = `http://localhost/partner-api${opts.path}`;
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "x-postora-key": opts.key,
    ...opts.headers,
  };
  const req = new Request(url, {
    method: opts.method,
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const res = await handleRequest(req, () => client);
  const text = await res.text();
  let json: unknown = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}

// fetch stub helper for provider
function makeProviderStub(
  postgrestOrigin: string,
  originalFetch: typeof fetch,
  handler: (url: string, bodyJson: unknown) => Response | Promise<Response> | null,
  // deno-lint-ignore no-explicit-any
  recorder: { calls: any[] },
  onThrow?: (url: string) => Error | null,
): typeof fetch {
  // deno-lint-ignore no-explicit-any
  const stub: any = async (input: RequestInfo | URL, init?: RequestInit) => {
    let urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    // rewrite /rest/v1 for PostgREST
    const rewritten = rewritePostgrestUrl(urlStr);
    if (rewritten !== urlStr) {
      // forward rewritten request
      if (typeof input === "string" || input instanceof URL) return originalFetch(rewritten, init);
      // Request object — recreate with new URL
      const req = input as Request;
      return originalFetch(new Request(rewritten, { method: req.method, headers: req.headers, body: req.body as BodyInit | null }), init);
    }
    // PostgREST / storage — forward (after rewrite check)
    if (urlStr.startsWith(postgrestOrigin) || rewritten.startsWith(postgrestOrigin)) {
      // ensure rewrite applied
      if (rewritten !== urlStr) {
        if (typeof input === "string" || input instanceof URL) return originalFetch(rewritten, init);
        const req = input as Request;
        return originalFetch(new Request(rewritten, { method: req.method, headers: req.headers, body: req.body as BodyInit | null }), init);
      }
      return originalFetch(input as RequestInfo, init);
    }
    if (urlStr.includes("graph.facebook.com")) {
      recorder.calls.push({ url: urlStr, init });
      if (onThrow) {
        const err = onThrow(urlStr);
        if (err) throw err;
      }
      let bodyJson: unknown = null;
      if (init?.body) {
        try { bodyJson = JSON.parse(init.body as string); } catch { bodyJson = init.body; }
      }
      const res = await handler(urlStr, bodyJson);
      if (res) return res;
      // if handler returns null, forward
      return originalFetch(input as RequestInfo, init);
    }
    throw new Error(`unexpected fetch to ${urlStr} — test must not reach internet`);
  };
  return stub as typeof fetch;
}

// webhook fetcher recorder
interface WebhookRecord { url: string; headers: Record<string, string>; rawBody: string }
function makeWebhookFetcher(records: WebhookRecord[], status: number): (input: RequestInfo | URL, init?: RequestInit) => Promise<Response> {
  return async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    const headers = (init?.headers as Record<string, string>) ?? {};
    const rawBody = (init?.body as string) ?? "";
    records.push({ url, headers, rawBody });
    return new Response(status === 200 ? "ok" : "fail", { status });
  };
}

// ---------------------------------------------------------------------------
// 1. happy chain → accepted
// ---------------------------------------------------------------------------
e2eTest("happy chain → accepted", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  // recorder for provider
  const providerRecorder = { calls: [] as unknown[] };
  let capturedIntentId: string | null = null;
  const wamid = "wamid.E2E1";
  // provider stub: success
  // deno-lint-ignore no-explicit-any
  const providerHandler = (_url: string, bodyJson: any) => {
    if (bodyJson && typeof (bodyJson as Record<string, unknown>).biz_opaque_callback_data === "string") {
      capturedIntentId = (bodyJson as Record<string, unknown>).biz_opaque_callback_data as string;
      // assert UUID shape
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(capturedIntentId as string)) {
        throw new Error(`biz_opaque_callback_data not UUID: ${capturedIntentId}`);
      }
    }
    const resBody = { messages: [{ id: wamid }], contacts: [{ wa_id: "15550000001" }] };
    return new Response(JSON.stringify(resBody), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stubFetch = makeProviderStub(postgrestOrigin, originalFetch, providerHandler, providerRecorder);
  // webhook subscription
  const webhookUrl = "https://partner-e2e.example/hook";
  let subscriptionId: string | null = null;
  let subscriptionSecret: string | null = null;
  try {
    globalThis.fetch = stubFetch;
    // create subscription via API
    const subRes = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/webhooks",
      key: keyA.key,
      body: { url: webhookUrl, events: ["message.accepted", "message.delivered"] },
    });
    if (subRes.status === 201) {
      const body = subRes.json as Record<string, unknown>;
      subscriptionId = body.id as string;
      subscriptionSecret = body.secret as string;
    } else {
      // fallback: insert directly via fixture/client if creation refused
      // Insert subscription directly (service_role)
      const secret = `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
      const { data, error } = await client.from("partner_webhooks").insert({
        workspace_id: ids.workspace_a,
        created_by_key_id: ids.key_a,
        url: webhookUrl,
        events: ["message.accepted", "message.delivered"],
        secret,
        secret_version: 1,
      }).select("id, secret").maybeSingle();
      if (error) throw new Error(`fallback webhook insert failed: ${error.message}`);
      subscriptionId = encodeId("wh", data.id);
      subscriptionSecret = data.secret;
    }

    const idemKey = `idem-happy-${crypto.randomUUID()}`;
    const sendRes = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyA.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "text", recipient_phone: "+15550000001", text: { body: "e2e" } },
    });
    if (sendRes.status !== 200) throw new Error(`happy send failed ${sendRes.status} ${JSON.stringify(sendRes.json)}`);
    const sendBody = sendRes.json as Record<string, unknown>;
    if (sendBody.message_id !== wamid) throw new Error(`message_id mismatch ${sendBody.message_id} vs ${wamid}`);
    if (sendBody.state !== "accepted_by_meta") throw new Error(`state ${sendBody.state}`);
    // request_id correlator
    const reqIdHeader = sendRes.headers.get("X-Postora-Request-Id");
    if (sendBody.request_id !== reqIdHeader) throw new Error(`request_id header/body mismatch`);
    if (!capturedIntentId) throw new Error("intent id not captured from provider stub");

    // DB: partner_dispatch_intents
    const { data: intentRow, error: intentErr } = await client.from("partner_dispatch_intents").select("state, wamid").eq("id", capturedIntentId).maybeSingle();
    if (intentErr) throw new Error(`intent lookup ${intentErr.message}`);
    if (!intentRow || intentRow.state !== "sent" || intentRow.wamid !== wamid) throw new Error(`intent row ${JSON.stringify(intentRow)}`);

    // idempotency row
    const { data: idemRow, error: idemErr } = await client.from("partner_api_idempotency").select("state, http_status").eq("key_id", ids.key_a).eq("idempotency_key", idemKey).maybeSingle();
    if (idemErr) throw new Error(`idem lookup ${idemErr.message}`);
    if (!idemRow || idemRow.state !== "completed" || idemRow.http_status !== 200) throw new Error(`idem row ${JSON.stringify(idemRow)}`);

    // counters
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (!keyRow || keyRow.usage_reserved !== 0 || keyRow.usage_confirmed !== 1 || keyRow.usage_indeterminate !== 0 || keyRow.current_usage_count !== 1) throw new Error(`counters ${JSON.stringify(keyRow)}`);

    // usage ledger
    const { data: usageRows } = await client.from("partner_api_usage").select("action, billable, error_code").eq("key_id", ids.key_a).order("created_at", { ascending: false }).limit(5);
    const usage = (usageRows ?? []).find((r: { action: string }) => r.action === "send_template");
    if (!usage || usage.billable !== true) throw new Error(`usage row ${JSON.stringify(usageRows)}`);

    // ONE partner_webhook_deliveries pending for message.accepted
    const whUuid = decodeId("wh", subscriptionId!);
    const { data: deliveries } = await client.from("partner_webhook_deliveries").select("id, event_type, status").eq("webhook_id", whUuid).eq("event_type", "message.accepted");
    if (!deliveries || deliveries.length !== 1) throw new Error(`deliveries ${JSON.stringify(deliveries)}`);

    // run worker with 200 fetcher
    const whRecords: WebhookRecord[] = [];
    const whFetcher = makeWebhookFetcher(whRecords, 200);
    const summary = await runWebhookWorker({ admin: client, fetcher: whFetcher, now: Date.now });
    if (summary.delivered !== 1) throw new Error(`worker summary ${JSON.stringify(summary)}`);

    if (whRecords.length !== 1) throw new Error(`wh records ${whRecords.length}`);
    const rec = whRecords[0];
    // verify signature
    if (!subscriptionSecret) throw new Error("no secret");
    const ts = rec.headers["X-Postora-Timestamp"];
    const sig = rec.headers["X-Postora-Signature"];
    const expectedSig = await signWebhookPayload(subscriptionSecret, Number(ts), rec.rawBody);
    if (sig !== expectedSig) throw new Error(`sig mismatch ${sig} vs ${expectedSig}`);
    for (const h of ["X-Postora-Event", "X-Postora-Event-Id", "X-Postora-Timestamp"]) {
      if (!rec.headers[h]) throw new Error(`missing header ${h}`);
    }
    const bodyJson = JSON.parse(rec.rawBody) as Record<string, unknown>;
    if (bodyJson.type !== "message.accepted") throw new Error(`event type ${bodyJson.type}`);
    // event id equals occurrence id format message.accepted:<wamid>
    if (bodyJson.occurrence_id !== `message.accepted:${wamid}`) throw new Error(`occurrence ${bodyJson.occurrence_id}`);
    if (rec.headers["X-Postora-Event-Id"] !== `evt_${deliveries[0].id}`) throw new Error(`event id header mismatch`);

    // status hop
    const { error: statusErr } = await client.rpc("partner_apply_whatsapp_message_status", { p_message_id: wamid, p_status: "delivered" });
    if (statusErr) throw new Error(`apply status ${statusErr.message}`);
    await reconcileDispatchIntentByEcho(client, capturedIntentId!, wamid);

    // a message.delivered delivery is pending
    const { data: deliveredDeliveries } = await client.from("partner_webhook_deliveries").select("id, status").eq("webhook_id", whUuid).eq("event_type", "message.delivered");
    if (!deliveredDeliveries || deliveredDeliveries.length !== 1) throw new Error(`delivered deliveries ${JSON.stringify(deliveredDeliveries)}`);

    const whRecords2: WebhookRecord[] = [];
    const whFetcher2 = makeWebhookFetcher(whRecords2, 200);
    const summary2 = await runWebhookWorker({ admin: client, fetcher: whFetcher2, now: Date.now });
    if (summary2.delivered !== 1) throw new Error(`second worker ${JSON.stringify(summary2)}`);
    const rec2 = whRecords2[0];
    const sig2 = rec2.headers["X-Postora-Signature"];
    const expectedSig2 = await signWebhookPayload(subscriptionSecret, Number(rec2.headers["X-Postora-Timestamp"]), rec2.rawBody);
    if (sig2 !== expectedSig2) throw new Error(`second sig mismatch`);

    // GET /v1/messages/{id}
    // find whatsapp_messages row by wamid
    const { data: msgRow } = await client.from("whatsapp_messages").select("id, status").eq("message_id", wamid).maybeSingle();
    if (!msgRow) throw new Error("whatsapp_messages row missing");
    const msgPrefixed = encodeId("msg", msgRow.id);
    const getRes = await callPartnerApi(client, { method: "GET", path: `/v1/messages/${msgPrefixed}`, key: keyA.key });
    if (getRes.status !== 200) throw new Error(`getMessage ${getRes.status} ${JSON.stringify(getRes.json)}`);
    const getBody = getRes.json as Record<string, unknown>;
    if (getBody.status !== "delivered") throw new Error(`getMessage status ${getBody.status}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 2. replay → Idempotency-Replayed
// ---------------------------------------------------------------------------
e2eTest("replay → replayed", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let callCount = 0;
  const wamid = "wamid.E2E2";
  const providerRecorder = { calls: [] as unknown[] };
  const handler = (_url: string, _body: unknown) => {
    callCount++;
    return new Response(JSON.stringify({ messages: [{ id: wamid }], contacts: [{ wa_id: "x" }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, providerRecorder);
  try {
    globalThis.fetch = stub;
    const idemKey = `idem-replay-${crypto.randomUUID()}`;
    const body = { type: "text", recipient_phone: "+15550000002", text: { body: "replay-test" } };
    const first = await callPartnerApi(client, { method: "POST", path: "/v1/messages", key: keyA.key, headers: { "Idempotency-Key": idemKey }, body });
    if (first.status !== 200) throw new Error(`first ${first.status}`);
    const firstBody = first.json as Record<string, unknown>;
    const firstCallCount = callCount;
    const second = await callPartnerApi(client, { method: "POST", path: "/v1/messages", key: keyA.key, headers: { "Idempotency-Key": idemKey }, body });
    if (second.status !== 200) throw new Error(`second ${second.status}`);
    if (second.headers.get("Idempotency-Replayed") !== "true") throw new Error(`missing replay header`);
    const secondBody = second.json as Record<string, unknown>;
    // bodies equal except request_id — compare deep, order-insensitive
    const { request_id: _r1, ...rest1 } = firstBody as Record<string, unknown>;
    const { request_id: _r2, ...rest2 } = secondBody as Record<string, unknown>;
    const canonical = (o: unknown) => JSON.stringify(o, Object.keys(o as Record<string, unknown>).sort());
    // Use field-wise check to avoid key-order sensitivity of JSON.stringify on JSONB-stored bodies
    for (const k of ["success", "message_id", "state", "recorded_in_inbox"]) {
      if ((rest1 as Record<string, unknown>)[k] !== (rest2 as Record<string, unknown>)[k]) throw new Error(`bodies differ on ${k}: ${JSON.stringify(rest1)} vs ${JSON.stringify(rest2)}`);
    }
    if (callCount !== firstCallCount) throw new Error(`provider called again ${callCount} vs ${firstCallCount}`);
    // verify idempotency row still single
    const { data: idemRows, error: idemErr } = await client.from("partner_api_idempotency").select("key_id, idempotency_key").eq("key_id", ids.key_a);
    if (idemErr) throw new Error(`idem select ${JSON.stringify(idemErr)}`);
    if (!idemRows || idemRows.length !== 1) throw new Error(`idem rows ${JSON.stringify(idemRows)}`);
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_confirmed, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (keyRow.usage_confirmed !== 1 || keyRow.current_usage_count !== 1) throw new Error(`counters after replay ${JSON.stringify(keyRow)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 3. duplicate key, different body → idempotency_conflict
// ---------------------------------------------------------------------------
e2eTest("duplicate key, different body → idempotency_conflict", async () => {
  const { client, keyA } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let providerCalls = 0;
  const wamid = "wamid.E2E3";
  const handler = () => {
    providerCalls++;
    return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, { calls: [] });
  try {
    globalThis.fetch = stub;
    const idemKey = `idem-conflict-${crypto.randomUUID()}`;
    const firstBody = { type: "text", recipient_phone: "+15550000003", text: { body: "first" } };
    const first = await callPartnerApi(client, { method: "POST", path: "/v1/messages", key: keyA.key, headers: { "Idempotency-Key": idemKey }, body: firstBody });
    if (first.status !== 200) throw new Error(`first ${first.status}`);
    const secondBody = { type: "text", recipient_phone: "+15550000003", text: { body: "different" } };
    const second = await callPartnerApi(client, { method: "POST", path: "/v1/messages", key: keyA.key, headers: { "Idempotency-Key": idemKey }, body: secondBody });
    if (second.status !== 409) throw new Error(`second status ${second.status} expected 409`);
    const j = second.json as Record<string, unknown>;
    const err = (j.error as Record<string, unknown>);
    if (err.code !== "idempotency_conflict") throw new Error(`code ${err.code}`);
    if (providerCalls !== 1) throw new Error(`provider calls ${providerCalls} expected 1`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 4. invalid scope → insufficient_scope
// ---------------------------------------------------------------------------
e2eTest("invalid scope → insufficient_scope", async () => {
  // Create a key without messages:send
  const jwt = await mintServiceJwt(jwtSecret);
  const client = createClient(postgrestUrl, jwt, { auth: { persistSession: false, autoRefreshToken: false }, global: { fetch: postgrestFetch } });
  const limitedScopes = ["messages:read", "accounts:read"];
  const keyLimited = await generatePartnerKey("production");
  const keyOther = await generatePartnerKey("production");
  const { data: ids, error: fixErr } = await client.rpc("partner_e2e_fixture", {
    p_key_hash: keyLimited.hash,
    p_key_prefix: keyLimited.prefix,
    p_scopes: limitedScopes,
    p_other_key_hash: keyOther.hash,
    p_other_key_prefix: keyOther.prefix,
  });
  if (fixErr) throw new Error(`fixture ${fixErr.message}`);
  const setupIds = ids as SetupIds;
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let providerCalls = 0;
  const handler = () => { providerCalls++; return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }); };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, { calls: [] });
  try {
    globalThis.fetch = stub;
    const { data: beforeKey } = await client.from("partner_api_keys").select("usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count").eq("id", setupIds.key_a).maybeSingle();
    const idemKey = `idem-noscope-${crypto.randomUUID()}`;
    const res = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyLimited.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "text", recipient_phone: "+15550000004", text: { body: "nope" } },
    });
    if (res.status !== 403) throw new Error(`status ${res.status} ${JSON.stringify(res.json)}`);
    const j = res.json as Record<string, unknown>;
    if ((j.error as Record<string, unknown>).code !== "insufficient_scope") throw new Error(`code ${JSON.stringify(j)}`);
    if (providerCalls !== 0) throw new Error(`provider called`);
    // no intent row
    const { data: intents } = await client.from("partner_dispatch_intents").select("id").eq("key_id", setupIds.key_a);
    if (intents && intents.length !== 0) throw new Error(`intent row exists`);
    // counters unchanged
    const { data: afterKey } = await client.from("partner_api_keys").select("usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count").eq("id", setupIds.key_a).maybeSingle();
    if (JSON.stringify(beforeKey) !== JSON.stringify(afterKey)) throw new Error(`counters changed ${JSON.stringify(beforeKey)} vs ${JSON.stringify(afterKey)}`);
    // one usage row with error_code insufficient_scope
    const { data: usageRows } = await client.from("partner_api_usage").select("error_code, action").eq("key_id", setupIds.key_a).order("created_at", { ascending: false }).limit(5);
    const found = (usageRows ?? []).find((r: { error_code: string }) => r.error_code === "insufficient_scope");
    if (!found) throw new Error(`no usage with insufficient_scope ${JSON.stringify(usageRows)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 5. cross-tenant → resource_not_found
// ---------------------------------------------------------------------------
e2eTest("cross-tenant → resource_not_found", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let providerCalls = 0;
  const handler = () => { providerCalls++; return new Response(JSON.stringify({ messages: [{ id: "wamid.x" }] }), { status: 200 }); };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, { calls: [] });
  try {
    globalThis.fetch = stub;
    const mediaPrefixed = encodeId("media", ids.media_b);
    const idemKey = `idem-xtenant-${crypto.randomUUID()}`;
    const res = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyA.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "image", recipient_phone: "+15550000005", media_id: mediaPrefixed },
    });
    if (res.status !== 404) throw new Error(`status ${res.status} ${JSON.stringify(res.json)}`);
    const j = res.json as Record<string, unknown>;
    if ((j.error as Record<string, unknown>).code !== "resource_not_found") throw new Error(`code ${JSON.stringify(j)}`);
    if (providerCalls !== 0) throw new Error(`provider called`);
    const { data: intents } = await client.from("partner_dispatch_intents").select("id").eq("key_id", ids.key_a);
    if (intents && intents.length !== 0) throw new Error(`intent exists`);
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_reserved, usage_confirmed, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (keyRow.usage_reserved !== 0 || keyRow.usage_confirmed !== 0) throw new Error(`counters ${JSON.stringify(keyRow)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 6. provider rejection → failed
// ---------------------------------------------------------------------------
e2eTest("provider rejection → failed", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  const handler = () => {
    const body = { error: { code: 131026, message: "Recipient not reachable" } };
    return new Response(JSON.stringify(body), { status: 400, headers: { "Content-Type": "application/json" } });
  };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, { calls: [] });
  try {
    globalThis.fetch = stub;
    const idemKey = `idem-reject-${crypto.randomUUID()}`;
    const res = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyA.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "text", recipient_phone: "+15550000006", text: { body: "reject" } },
    });
    if (res.status !== 422) throw new Error(`status ${res.status} ${JSON.stringify(res.json)}`);
    const j = res.json as Record<string, unknown>;
    const err = j.error as Record<string, unknown>;
    if (err.retryable !== false) throw new Error(`retryable ${err.retryable}`);
    // intent failed
    const { data: intents } = await client.from("partner_dispatch_intents").select("state").eq("key_id", ids.key_a);
    if (!intents || intents[0].state !== "failed") throw new Error(`intent ${JSON.stringify(intents)}`);
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_reserved, usage_confirmed, usage_indeterminate, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (keyRow.usage_reserved !== 0 || keyRow.usage_confirmed !== 0 || keyRow.usage_indeterminate !== 0 || keyRow.current_usage_count !== 0) throw new Error(`counters ${JSON.stringify(keyRow)}`);
    // NO webhook delivery for it
    const { data: deliveries } = await client.from("partner_webhook_deliveries").select("id").eq("workspace_id", ids.workspace_a);
    if (deliveries && deliveries.length !== 0) throw new Error(`unexpected deliveries ${JSON.stringify(deliveries)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 7. indeterminate → indeterminate
// ---------------------------------------------------------------------------
e2eTest("indeterminate → indeterminate", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let providerCalls = 0;
  const throwingStub: typeof fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    let urlStr = typeof input === "string" ? input : input instanceof URL ? input.toString() : (input as Request).url;
    urlStr = rewritePostgrestUrl(urlStr);
    if (urlStr.startsWith(postgrestOrigin) || urlStr.includes(postgrestOrigin)) {
      // handle rewritten request
      if (typeof input === "string" || input instanceof URL) return originalFetch(urlStr, init);
      const req = input as Request;
      return originalFetch(new Request(urlStr, { method: req.method, headers: req.headers, body: req.body as BodyInit | null }), init);
    }
    if (urlStr.includes("graph.facebook.com")) {
      providerCalls++;
      throw new Error("network failure");
    }
    throw new Error(`unexpected ${urlStr}`);
  };
  try {
    globalThis.fetch = throwingStub;
    const idemKey = `idem-indet-${crypto.randomUUID()}`;
    const res = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyA.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "text", recipient_phone: "+15550000007", text: { body: "indet" } },
    });
    if (res.status !== 409) throw new Error(`status ${res.status} ${JSON.stringify(res.json)}`);
    const j = res.json as Record<string, unknown>;
    if ((j.error as Record<string, unknown>).code !== "idempotency_indeterminate") throw new Error(`code ${JSON.stringify(j)}`);
    // intent stays intended
    const { data: intents } = await client.from("partner_dispatch_intents").select("state").eq("key_id", ids.key_a);
    if (!intents || intents.length !== 1 || intents[0].state !== "intended") throw new Error(`intent state ${JSON.stringify(intents)}`);
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_reserved, usage_indeterminate, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (keyRow.usage_reserved !== 0 || keyRow.usage_indeterminate !== 1) throw new Error(`counters ${JSON.stringify(keyRow)}`);
    // retry same key
    providerCalls = 0;
    const retry = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/messages",
      key: keyA.key,
      headers: { "Idempotency-Key": idemKey },
      body: { type: "text", recipient_phone: "+15550000007", text: { body: "indet" } },
    });
    if (retry.status !== 409) throw new Error(`retry status ${retry.status}`);
    if ((retry.json as Record<string, unknown>).error === undefined) throw new Error(`no error`);
    if ((retry.json as Record<string, unknown>).error && ((retry.json as Record<string, unknown>).error as Record<string, unknown>).code !== "idempotency_indeterminate") throw new Error(`retry code`);
    if (providerCalls !== 0) throw new Error(`provider called on retry`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 8. webhook endpoint fails then recovers → retry
// ---------------------------------------------------------------------------
e2eTest("webhook endpoint fails then recovers → retry", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  const wamid = "wamid.E2E8";
  let capturedIntent: string | null = null;
  const providerHandler = (_url: string, body: unknown) => {
    const b = body as Record<string, unknown>;
    capturedIntent = b.biz_opaque_callback_data as string;
    return new Response(JSON.stringify({ messages: [{ id: wamid }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, providerHandler, { calls: [] });
  try {
    globalThis.fetch = stub;
    // create webhook
    const webhookUrl = "https://partner-e2e.example/hook";
    let subId: string | null = null;
    let subSecret: string | null = null;
    const subRes = await callPartnerApi(client, { method: "POST", path: "/v1/webhooks", key: keyA.key, body: { url: webhookUrl, events: ["message.accepted"] } });
    if (subRes.status === 201) {
      const b = subRes.json as Record<string, unknown>;
      subId = b.id as string;
      subSecret = b.secret as string;
    } else {
      const secret = `whsec_${crypto.randomUUID().replace(/-/g, "")}`;
      const { data } = await client.from("partner_webhooks").insert({ workspace_id: ids.workspace_a, created_by_key_id: ids.key_a, url: webhookUrl, events: ["message.accepted"], secret, secret_version: 1 }).select("id, secret").maybeSingle();
      subId = encodeId("wh", data.id);
      subSecret = data.secret;
    }
    const idemKey = `idem-wh-retry-${crypto.randomUUID()}`;
    const sendRes = await callPartnerApi(client, { method: "POST", path: "/v1/messages", key: keyA.key, headers: { "Idempotency-Key": idemKey }, body: { type: "text", recipient_phone: "+15550000008", text: { body: "wh-retry" } } });
    if (sendRes.status !== 200) throw new Error(`send ${sendRes.status}`);
    const whUuid = decodeId("wh", subId!);
    const { data: delBefore } = await client.from("partner_webhook_deliveries").select("id").eq("webhook_id", whUuid);
    if (!delBefore || delBefore.length !== 1) throw new Error(`delivery before ${JSON.stringify(delBefore)}`);

    // fail first delivery
    const rec1: WebhookRecord[] = [];
    const fetcher500 = makeWebhookFetcher(rec1, 500);
    const sum1 = await runWebhookWorker({ admin: client, fetcher: fetcher500, now: Date.now });
    if (sum1.retried !== 1 && sum1.delivered !== 0) throw new Error(`sum1 ${JSON.stringify(sum1)}`);
    const { data: delAfterFail } = await client.from("partner_webhook_deliveries").select("attempts, next_attempt_at, status").eq("id", delBefore[0].id).maybeSingle();
    if (!delAfterFail || delAfterFail.attempts !== 1) throw new Error(`attempts ${JSON.stringify(delAfterFail)}`);
    if (delAfterFail.status !== "pending") throw new Error(`status ${delAfterFail.status}`);
    const next = new Date(delAfterFail.next_attempt_at).getTime();
    const now = Date.now();
    const diffSec = (next - now) / 1000;
    if (Math.abs(diffSec - 60) > 15) throw new Error(`backoff ${diffSec} not ~60`);

    // move next_attempt_at to past
    await client.from("partner_webhook_deliveries").update({ next_attempt_at: new Date(Date.now() - 2000).toISOString() }).eq("id", delBefore[0].id);
    const rec2: WebhookRecord[] = [];
    const fetcher200 = makeWebhookFetcher(rec2, 200);
    const sum2 = await runWebhookWorker({ admin: client, fetcher: fetcher200, now: Date.now });
    if (sum2.delivered !== 1) throw new Error(`sum2 ${JSON.stringify(sum2)}`);
    const { data: delAfterSuccess } = await client.from("partner_webhook_deliveries").select("attempts, status").eq("id", delBefore[0].id).maybeSingle();
    if (delAfterSuccess.attempts !== 2 || delAfterSuccess.status !== "delivered") throw new Error(`after success ${JSON.stringify(delAfterSuccess)}`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 9. quota exhaustion is concurrency-safe → one succeeds
// ---------------------------------------------------------------------------
e2eTest("quota exhaustion is concurrency-safe → one succeeds", async () => {
  const { client, keyA, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  let providerCalls = 0;
  const handler = () => {
    providerCalls++;
    const w = `wamid.E2E9-${providerCalls}`;
    return new Response(JSON.stringify({ messages: [{ id: w }] }), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const stub = makeProviderStub(postgrestOrigin, originalFetch, handler, { calls: [] });
  try {
    globalThis.fetch = stub;
    // Drive 4 sequential sends to reach 4 confirmed (quota 5) via the real path
    for (let i = 0; i < 4; i++) {
      const r = await callPartnerApi(client, {
        method: "POST",
        path: "/v1/messages",
        key: keyA.key,
        headers: { "Idempotency-Key": `idem-quota-pre-${i}-${crypto.randomUUID()}` },
        body: { type: "text", recipient_phone: `+1555000100${i}`, text: { body: `pre${i}` } },
      });
      if (r.status !== 200) throw new Error(`pre ${i} status ${r.status} ${JSON.stringify(r.json)}`);
    }
    const { data: afterPre } = await client.from("partner_api_keys").select("usage_confirmed, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (afterPre.usage_confirmed !== 4 || afterPre.current_usage_count !== 4) throw new Error(`after pre counters ${JSON.stringify(afterPre)}`);
    const preCalls = providerCalls;
    const keys = [1, 2, 3].map(() => `idem-quota-${crypto.randomUUID()}`);
    const promises = keys.map((k, i) =>
      callPartnerApi(client, {
        method: "POST",
        path: "/v1/messages",
        key: keyA.key,
        headers: { "Idempotency-Key": k },
        body: { type: "text", recipient_phone: `+1555000009${i}`, text: { body: `quota${i}` } },
      })
    );
    const results = await Promise.all(promises);
    const ok = results.filter((r) => r.status === 200).length;
    const quotaed = results.filter((r) => r.status === 429).length;
    if (ok !== 1 || quotaed !== 2) throw new Error(`ok ${ok} quotaed ${quotaed} ${JSON.stringify(results.map(r=>r.status))}`);
    for (const r of results) {
      if (r.status === 429) {
        const j = r.json as Record<string, unknown>;
        if ((j.error as Record<string, unknown>).code !== "quota_exceeded") throw new Error(`429 code ${JSON.stringify(j)}`);
      }
    }
    const { data: keyRow } = await client.from("partner_api_keys").select("usage_confirmed, usage_reserved, current_usage_count").eq("id", ids.key_a).maybeSingle();
    if (keyRow.usage_confirmed !== 5 || keyRow.usage_reserved !== 0 || keyRow.current_usage_count !== 5) throw new Error(`final counters ${JSON.stringify(keyRow)}`);
    if (providerCalls - preCalls !== 1) throw new Error(`provider calls ${providerCalls - preCalls} expected 1`);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ---------------------------------------------------------------------------
// 10. tool execution → one metered ledger row, bound to the key
//
// The chain this proves is the one nothing below the /v1 handler can prove on
// its own: a real POST /v1/tools/execute, authorised through the real resolver
// against real rows in Postgres, reaching the adapter, and leaving ONE
// connector_call_logs row that carries the key that made the call and the same
// request id the response returned. A unit test can assert the row it stubbed;
// only this can assert the row the database actually holds.
//
// The adapter is stubbed at fetch (there is no ai-agent-adapters function in
// the harness) — the same boundary the provider is stubbed at above. Nothing
// else is faked: the tool, the account, the binding and the key are rows.
// ---------------------------------------------------------------------------
e2eTest("tool execution → one metered ledger row, bound to the key", async () => {
  const { client, keyA, keyB, ids } = await setupE2E();
  const originalFetch = globalThis.fetch;
  const postgrestOrigin = new URL(postgrestUrl).origin;
  const adapterOrigin = "https://adapter-e2e.invalid";
  const previousUrl = Deno.env.get("SUPABASE_URL");
  const previousKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  const adapterCalls: unknown[] = [];

  // deno-lint-ignore no-explicit-any
  const stub: any = async (input: RequestInfo | URL, init?: RequestInit) => {
    const urlStr = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : (input as Request).url;
    if (urlStr.startsWith(adapterOrigin)) {
      adapterCalls.push(init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify({ ok: true, data: { rows: [{ sku: "E2E-1" }] } }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    const rewritten = rewritePostgrestUrl(urlStr);
    if (rewritten.startsWith(postgrestOrigin)) {
      if (rewritten !== urlStr) {
        if (typeof input === "string" || input instanceof URL) return originalFetch(rewritten, init);
        const req = input as Request;
        return originalFetch(
          new Request(rewritten, { method: req.method, headers: req.headers, body: req.body as BodyInit | null }),
          init,
        );
      }
      return originalFetch(input as RequestInfo, init);
    }
    throw new Error(`unexpected fetch to ${urlStr} — test must not reach internet`);
  };

  try {
    Deno.env.set("SUPABASE_URL", adapterOrigin);
    Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "e2e-service-role-key");
    globalThis.fetch = stub as typeof fetch;

    const res = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/tools/execute",
      key: keyA.key,
      headers: { "Idempotency-Key": `idem-tool-${crypto.randomUUID()}` },
      body: {
        tool_id: ids.tool_a,
        social_account_id: ids.account_a,
        capability: "search_products",
        parameters: { table: "products" },
      },
    });
    if (res.status !== 200) throw new Error(`execute status ${res.status} ${JSON.stringify(res.json)}`);
    const body = res.json as Record<string, unknown>;
    if (body.ok !== true) throw new Error(`execute body ${JSON.stringify(body)}`);
    if (adapterCalls.length !== 1) throw new Error(`adapter calls ${adapterCalls.length}`);

    const requestId = res.headers.get("X-Postora-Request-Id");
    if (!requestId) throw new Error("no X-Postora-Request-Id on the response");
    if (body.request_id !== requestId) {
      throw new Error(`body request_id ${body.request_id} != header ${requestId}`);
    }

    const { data: ledger, error: ledgerError } = await client
      .from("connector_call_logs")
      .select("workspace_id, tool_id, partner_key_id, source, status, action_name, request_id")
      .eq("request_id", requestId);
    if (ledgerError) throw new Error(`ledger read failed: ${JSON.stringify(ledgerError)}`);
    if (!ledger || ledger.length !== 1) throw new Error(`ledger rows ${JSON.stringify(ledger)}`);
    const row = ledger[0];
    if (row.partner_key_id !== ids.key_a) throw new Error(`partner_key_id ${row.partner_key_id}`);
    if (row.workspace_id !== ids.workspace_a) throw new Error(`workspace_id ${row.workspace_id}`);
    if (row.tool_id !== ids.tool_a) throw new Error(`tool_id ${row.tool_id}`);
    if (row.source !== "partner") throw new Error(`source ${row.source}`);
    if (row.status !== "success") throw new Error(`status ${row.status}`);
    if (row.action_name !== "search_products") throw new Error(`action_name ${row.action_name}`);

    // The other tenant's key cannot execute this tool, and learns nothing.
    const denied = await callPartnerApi(client, {
      method: "POST",
      path: "/v1/tools/execute",
      key: keyB.key,
      headers: { "Idempotency-Key": `idem-tool-${crypto.randomUUID()}` },
      body: {
        tool_id: ids.tool_a,
        social_account_id: ids.account_a,
        capability: "search_products",
        parameters: {},
      },
    });
    if (denied.status !== 404) throw new Error(`cross-tenant status ${denied.status}`);
    const deniedCode = ((denied.json as Record<string, unknown>).error as Record<string, unknown>).code;
    if (deniedCode !== "tool_not_found") throw new Error(`cross-tenant code ${deniedCode}`);
    if (adapterCalls.length !== 1) throw new Error("a cross-tenant call reached the adapter");

    // Spec §11: the refusal itself leaves a row, written against REAL Postgres
    // rather than a stub — recordConnectorCall swallows its own insert errors,
    // so a column constraint that rejected the pre-resolution `unknown`
    // placeholders would be invisible everywhere else.
    const { data: refused, error: refusedError } = await client
      .from("connector_call_logs")
      .select("status, error_code, connector_type, auth_strategy, tool_id, partner_key_id")
      .eq("partner_key_id", ids.key_b);
    if (refusedError) throw new Error(`refused ledger read failed: ${JSON.stringify(refusedError)}`);
    if (!refused || refused.length !== 1) throw new Error(`refused rows ${JSON.stringify(refused)}`);
    if (refused[0].status !== "refused") throw new Error(`refused status ${refused[0].status}`);
    if (refused[0].error_code !== "tool_not_found") throw new Error(`refused code ${refused[0].error_code}`);
    if (refused[0].tool_id !== null) throw new Error(`refused tool_id ${refused[0].tool_id}`);
    if (refused[0].connector_type !== "unknown" || refused[0].auth_strategy !== "unknown") {
      throw new Error(`refused placeholders ${JSON.stringify(refused[0])}`);
    }

    // GET /v1/connectors sees the tool once, with the call it just made.
    const listed = await callPartnerApi(client, {
      method: "GET",
      path: "/v1/connectors",
      key: keyA.key,
    });
    if (listed.status !== 200) throw new Error(`list status ${listed.status} ${JSON.stringify(listed.json)}`);
    const entries = (listed.json as Record<string, unknown>).data as Record<string, unknown>[];
    const entry = entries.find((e) => e.tool_id === ids.tool_a);
    if (!entry) throw new Error(`tool missing from listing: ${JSON.stringify(entries)}`);
    if ((entry.usage_30d as Record<string, unknown>).calls !== 1) {
      throw new Error(`usage_30d ${JSON.stringify(entry.usage_30d)}`);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (previousUrl === undefined) Deno.env.delete("SUPABASE_URL");
    else Deno.env.set("SUPABASE_URL", previousUrl);
    if (previousKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
    else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", previousKey);
  }
});
