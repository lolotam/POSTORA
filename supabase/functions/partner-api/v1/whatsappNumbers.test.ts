// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleRequest } from "../index.ts";
import { decodeCursor } from "./pagination.ts";
import { endSessionRoute } from "./whatsappNumbers.ts";
import { withPartnerAuth } from "./authenticated.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: ID, workspace_id: "ws-1", platform: "whatsapp", platform_user_id: "15550001111",
  platform_username: "Support", connection_mode: "evolution_qr", account_metadata: {},
  access_token: "test-token",
  is_active: true, connected_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
};

function database(opts: {
  entitled?: boolean; qrEntitled?: boolean; scopes?: string[]; failTable?: string;
  claim?: string; rpcError?: { code: string; message: string }; lostRpc?: boolean;
  badRpcResult?: boolean; settleFails?: boolean;
  limiterFails?: boolean;
  deactivationFails?: boolean; mode?: string; syncOutcome?: unknown;
  leaseHeld?: boolean; unresolved?: boolean; noWorkspace?: boolean;
  accountPatch?: Record<string, unknown>;
  unbound?: boolean;
} = {}) {
  const reads: URL[] = [];
  const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
  const claims: Record<string, unknown>[] = [];
  const claimReads: URL[][] = [];
  const settlements: Array<{ url: URL; row: Record<string, unknown> }> = [];
  let storedHash: string | undefined;
  let settled: Record<string, unknown> | undefined;
  const admin = createClient("https://database.example", "test-key", {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { fetch: (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const table = url.pathname.split("/").at(-1)!;
      if (table === "consume_partner_rate_v2") {
        if (opts.limiterFails) return Promise.resolve(Response.json({ message: "limiter unavailable" }, { status: 500 }));
        return Promise.resolve(Response.json({ allowed: true, remaining: 59, reset_seconds: 42 }));
      }
      if (table === "claim_partner_idempotency") {
        const row = JSON.parse(String(init?.body));
        claimReads.push([...reads]);
        claims.push(row);
        const outcome = storedHash && row.p_request_hash !== storedHash ? "conflict" : opts.claim ?? (settled ? "replay" : "claimed");
        storedHash ??= row.p_request_hash;
        return Promise.resolve(Response.json({ outcome, attempt_token: "attempt-1", http_status: settled?.http_status ?? 202,
          response_body: settled?.response_body ?? { saved: "original outcome", request_id: "original-request" } }));
      }
      if (table === "register_partner_whatsapp_number") {
        writes.push({ table, row: JSON.parse(String(init?.body)) });
        if (opts.lostRpc) return Promise.reject(new Error("RPC response lost"));
        return Promise.resolve(opts.rpcError ? Response.json(opts.rpcError, { status: 400 }) :
          Response.json(opts.badRpcResult ? {} : { account_id: ID }));
      }
      if (table === "claim_whatsapp_history_sync") {
        writes.push({ table, row: JSON.parse(String(init?.body)) });
        return Promise.resolve(Response.json(!opts.leaseHeld));
      }
      if (table === "partner_api_idempotency" && init?.method === "PATCH") {
        const row = JSON.parse(String(init.body));
        settlements.push({ url, row });
        if (row.state === "completed" && opts.settleFails) return Promise.resolve(Response.json({ message: "settle failed" }, { status: 500 }));
        settled = row;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (["whatsapp_evolution_instances", "social_accounts"].includes(table) && init?.method === "PATCH") {
        writes.push({ table, row: JSON.parse(String(init.body)) });
        if (table === "social_accounts" && opts.deactivationFails) return Promise.resolve(Response.json({ message: "private failure" }, { status: 500 }));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (init?.method === "POST") {
        assert(["system_logs", "partner_api_usage"].includes(table), `unexpected write to ${table}`);
        writes.push({ table, row: JSON.parse(String(init.body)) });
        return Promise.resolve(new Response(null, { status: 201 }));
      }
      reads.push(url);
      if (table === opts.failTable) {
        return Promise.resolve(Response.json({ code: "57014", message: "private database failure" }, { status: 500 }));
      }
      const rows: Record<string, unknown[]> = {
        partner_api_keys: [{
          id: "key-1", workspace_id: "ws-1", social_account_id: OTHER,
          key_prefix: "pk_live_test", scopes: opts.scopes ?? ["whatsapp:numbers.read"],
          rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
        }],
        partner_provisioned_workspaces: [{ owner_user_id: "owner-1" }],
        app_settings: [{ key: "feature_msg_whatsapp", value: opts.entitled ?? true },
          { key: "feature_wa_evolution_qr_enabled", value: opts.qrEntitled ?? true },
          { key: "feature_wa_cloud_api_enabled", value: true }],
        user_feature_overrides: [],
        partner_api_key_accounts: opts.unbound || (url.searchParams.has("social_account_id") && url.searchParams.get("social_account_id") !== `eq.${ID}`) ? [] : [{ social_account_id: ID }],
        social_accounts: url.searchParams.get("id")?.startsWith("eq.") ? [{ ...ROW, connection_mode: opts.mode ?? ROW.connection_mode,
          user_id: "owner-1", workspace_id: opts.noWorkspace ? null : ROW.workspace_id,
          platform_user_id: opts.unresolved ? `pending_${ID}` : ROW.platform_user_id, ...opts.accountPatch }] :
          [ROW, { ...ROW, id: OTHER }],
        whatsapp_evolution_instances: [{ instance_name: `postora_${ID}`, jwt_key: "private-key", last_qr: null,
          sync_started_at: null, last_sync_at: null, last_sync_outcome: opts.syncOutcome ?? null }],
      };
      assert(Object.hasOwn(rows, table), `unexpected read of ${table}`);
      return Promise.resolve(Response.json(rows[table]));
    } },
  });
  return { admin, reads, writes, claims, claimReads, settlements };
}

function request(suffix = "") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/whatsapp/numbers${suffix}`, {
    headers: { "x-postora-key": "pk_live_test" },
  });
}

Deno.test("number route returns a page, cursor and request id through authentication and binding", async () => {
  const client = database();
  const res = await handleRequest(request("?limit=1"), () => client.admin);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.data.map((number: { account_id: string }) => number.account_id), [ID]);
  assertEquals(decodeCursor(body.next_cursor), { timestamp: ROW.updated_at, id: ID });
  assertEquals(body.request_id, res.headers.get("X-Postora-Request-Id"));
  assertEquals(res.headers.get("X-RateLimit-Remaining"), "59");
  assertEquals(client.reads.map((url) => url.pathname.split("/").at(-1)), [
    "partner_api_keys", "partner_provisioned_workspaces", "app_settings",
    "user_feature_overrides", "partner_api_key_accounts", "social_accounts",
  ]);
  const binding = client.reads.find((url) => url.pathname.endsWith("/partner_api_key_accounts"))!;
  assertEquals(binding.searchParams.get("key_id"), "eq.key-1");
  assertEquals(binding.searchParams.get("workspace_id"), "eq.ws-1");
  const accounts = client.reads.at(-1)!;
  assertEquals(accounts.searchParams.get("id"), `in.(${ID})`);
  assertEquals(accounts.searchParams.get("workspace_id"), "eq.ws-1");
  assertEquals(accounts.searchParams.get("limit"), "2");
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.billable, false);
});

for (const [suffix, action] of [["", "list_whatsapp_numbers"], [`/${ID}`, "get_whatsapp_number"]]) {
  Deno.test(`${action}: disabled feature returns logged 403 before binding or account reads`, async () => {
    const client = database({ entitled: false });
    const res = await handleRequest(request(suffix), () => client.admin);
    assertEquals(res.status, 403);
    const body = await res.json();
    assertEquals(body.error.code, "feature_not_entitled");
    assert(!client.reads.some((url) => /\/(social_accounts|partner_api_key_accounts)$/.test(url.pathname)));
    const log = client.writes.find((write) => write.table === "system_logs")!;
    assertEquals((log.row.metadata as Record<string, unknown>).action, action);
    const ledger = client.writes.find((write) => write.table === "partner_api_usage")!;
    assertEquals(ledger.row.action, action);
    assertEquals(ledger.row.error_code, "feature_not_entitled");
  });
}

Deno.test("unbound number returns a logged 404 without querying the requested account", async () => {
  const client = database();
  const res = await handleRequest(request(`/${OTHER}`), () => client.admin);
  assertEquals(res.status, 404);
  assertEquals((await res.json()).error.code, "resource_not_found");
  assert(!client.reads.some((url) => url.pathname.endsWith("/social_accounts")));
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "resource_not_found");
});

Deno.test("bound item renders its phone number and request id", async () => {
  const client = database();
  const res = await handleRequest(request(`/${ID}`), () => client.admin);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), {
    account_id: ID, phone_number: "15550001111", display_name: "Support",
    connection_mode: "evolution_qr", status: "connected", connected_at: ROW.connected_at,
    request_id: res.headers.get("X-Postora-Request-Id"),
  });
});

for (const suffix of ["", `/${ID}`]) {
  Deno.test(`legacy WhatsApp scopes cannot authorize number read ${suffix || "collection"}`, async () => {
    const client = database({ scopes: ["whatsapp:template.send", "whatsapp:templates.read", "whatsapp:webhooks.manage"] });
    const res = await handleRequest(request(suffix), () => client.admin);
    assertEquals(res.status, 403);
    assertEquals((await res.json()).error.code, "insufficient_scope");
    assertEquals(client.reads.length, 1);
  });
}

for (const failTable of ["partner_provisioned_workspaces", "partner_api_key_accounts", "social_accounts"]) {
  Deno.test(`number read failure in ${failTable} is a logged sanitized 500`, async () => {
    const client = database({ failTable });
    const res = await handleRequest(request(), () => client.admin);
    assertEquals(res.status, 500);
    const body = await res.json();
    assertEquals(body.error.code, "internal_error");
    assert(!JSON.stringify(body).includes("private database failure"));
    assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "internal_error");
  });
}

Deno.test("invalid pagination is logged and refused before the account read", async () => {
  const client = database();
  const res = await handleRequest(request("?cursor=broken"), () => client.admin);
  assertEquals(res.status, 400);
  assertEquals((await res.json()).error.code, "invalid_request");
  assert(!client.reads.some((url) => url.pathname.endsWith("/social_accounts")));
  assertEquals(client.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "invalid_request");
});

const REGISTRATION = { connection_name: "Support", connection_mode: "evolution_qr", risk_consent: {
  accepted: true, accepted_by: "tenant@example.com", accepted_at: "2026-09-10T09:00:00Z", accepted_ip: "203.0.113.9",
} };
const WRITE_SCOPES = ["whatsapp:numbers.manage", "whatsapp:numbers.read"];
function mutation(suffix = "", body: unknown = REGISTRATION, key: string | null = "registration-key", method = "POST") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/whatsapp/numbers${suffix}`, {
    method, headers: { "x-postora-key": "pk_live_test", "Content-Type": "application/json",
      ...(key === null ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(body),
  });
}

Deno.test("a replay after the binding is removed answers 404 and never reads idempotency", async () => {
  const db = database({ scopes: WRITE_SCOPES, claim: "replay", unbound: true });
  const response = await handleRequest(mutation(`/${ID}/pairing`, {}, "K"), () => db.admin);
  assertEquals(response.status, 404);
  assertEquals((await response.json()).error.code, "resource_not_found");
  assertEquals(db.claims.length, 0);
  assert(!db.reads.some((url) => url.pathname.endsWith("/social_accounts")));
});

async function claimWithoutDispatch(db: ReturnType<typeof database>, req: Request, numberSpecific: boolean) {
  const savedFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = () => {
    providerCalls++;
    return Promise.reject(new Error("Unexpected provider dispatch"));
  };
  try {
    const response = await handleRequest(req, () => db.admin);
    assertEquals(providerCalls, 0);
    assertEquals(db.claims.length, 1);
    assertEquals(db.claimReads[0], db.reads, "no execute-body reads after claiming");
    const accounts = db.claimReads[0].filter((url) => url.pathname.endsWith("/social_accounts"));
    const bindings = db.claimReads[0].filter((url) => url.pathname.endsWith("/partner_api_key_accounts"));
    assertEquals(accounts.length, numberSpecific ? 1 : 0);
    assertEquals(bindings.length, numberSpecific ? 1 : 0);
    if (numberSpecific) {
      assertEquals(accounts[0].searchParams.get("workspace_id"), "eq.ws-1");
      assertEquals(accounts[0].searchParams.get("id"), `eq.${ID}`);
      assertEquals(bindings[0].searchParams.get("workspace_id"), "eq.ws-1");
      assertEquals(bindings[0].searchParams.get("key_id"), "eq.key-1");
    }
    const flags = db.claimReads[0].filter((url) => url.pathname.endsWith("/app_settings"));
    assertEquals(flags.length, 1);
    assertEquals(flags[0].searchParams.get("key"), "in.(feature_msg_whatsapp,feature_wa_evolution_qr_enabled)");
    assertEquals(db.reads.some((url) => url.pathname.endsWith("/whatsapp_evolution_instances")), false);
    assertEquals(db.writes.filter((write) => !["system_logs", "partner_api_usage"].includes(write.table)), []);
    assertEquals(db.settlements.length, 0);
    return response;
  } finally {
    globalThis.fetch = savedFetch;
  }
}

for (const suffix of ["", `/${ID}/pairing`, `/${ID}/history-sync`]) {
  for (const claim of ["replay", "conflict", "in_progress", "indeterminate"]) {
    Deno.test(`write ${suffix || "registration"} handles ${claim} without dispatch`, async () => {
      const db = database({ scopes: WRITE_SCOPES, claim });
      const res = await claimWithoutDispatch(db, mutation(suffix, suffix ? {} : REGISTRATION), Boolean(suffix));
      const body = await res.json();
      if (claim === "replay") {
        assertEquals(res.status, 202);
        assertEquals(body, { saved: "original outcome", request_id: "original-request" });
        assertEquals(res.headers.get("Idempotency-Replayed"), "true");
      } else assertEquals(body.error.code, `idempotency_${claim}`);
    });
  }
  Deno.test(`write ${suffix || "registration"} requires Idempotency-Key before claiming`, async () => {
    const db = database({ scopes: WRITE_SCOPES });
    const res = await handleRequest(mutation(suffix, {}, null), () => db.admin);
    assertEquals((await res.json()).error.code, "missing_idempotency_key");
    assertEquals(db.claims.length, 0);
  });
}

Deno.test("registration settles success with its attempt token and replays without creating twice", async () => {
  const db = database({ scopes: WRITE_SCOPES });
  const first = await handleRequest(mutation(), () => db.admin);
  assertEquals(first.status, 201);
  const created = await first.json();
  assertEquals(created.account_id, ID);
  const second = await handleRequest(mutation(), () => db.admin);
  assertEquals(second.status, 201);
  assertEquals(await second.json(), created);
  assertEquals(db.writes.filter((write) => write.table === "register_partner_whatsapp_number").length, 1);
  const settlement = db.settlements[0];
  assertEquals(settlement.row.http_status, 201);
  assertEquals(settlement.row.response_body, created);
  assertEquals(settlement.url.searchParams.get("attempt_token"), "eq.attempt-1");
  assertEquals(settlement.url.searchParams.get("state"), "eq.processing");
  assertEquals(settlement.url.searchParams.get("key_id"), "eq.key-1");
  assertEquals(settlement.url.searchParams.get("idempotency_key"), "eq.registration-key");
});

Deno.test("consent refusal settles and changing consent under the same key conflicts", async () => {
  const db = database({ scopes: WRITE_SCOPES });
  const res = await handleRequest(mutation("", { ...REGISTRATION, risk_consent: { ...REGISTRATION.risk_consent, accepted: false } }), () => db.admin);
  assertEquals((await res.json()).error.code, "invalid_request");
  assertEquals(db.settlements[0].row.http_status, 400);
  const retry = await handleRequest(mutation(), () => db.admin);
  assertEquals((await retry.json()).error.code, "idempotency_conflict");
  assert(!db.writes.some((write) => write.table === "register_partner_whatsapp_number"));
});

for (const connection_mode of ["cloud_api", "coexistence"]) {
  Deno.test(`${connection_mode} onboarding returns a settled unsupported capability`, async () => {
    const db = database({ scopes: WRITE_SCOPES });
    const res = await handleRequest(mutation("", { ...REGISTRATION, connection_mode }), () => db.admin);
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.error.code, "unsupported_capability");
    assert(body.error.message.includes("onboarding"));
    assertEquals(db.settlements[0].row.response_body, body);
    assert(!db.writes.some((write) => write.table === "register_partner_whatsapp_number"));
  });
}

for (const [code, message, expected] of [
  ["23514", "social account quota exceeded for the workspace owner", "quota_exceeded"],
  ["23514", "risk consent attestation requires accepted_by", "invalid_request"],
  ["23514", "connection name must be 1 to 60 characters", "invalid_request"],
  ["23514", "calling key is not an active key of workspace", "invalid_request"],
  ["P0002", "calling key is not an active key of workspace private-id", "invalid_request"],
  ["P0002", "workspace private-id was not provisioned through the platform tier", "invalid_request"],
  ["23505", "private database constraint", "internal_error"],
]) {
  Deno.test(`registration maps RPC ${code}: ${message}`, async () => {
    const db = database({ scopes: WRITE_SCOPES, rpcError: { code, message } });
    const res = await handleRequest(mutation(), () => db.admin);
    const body = await res.json();
    assertEquals(body.error.code, expected);
    assertEquals(db.settlements[0].row.response_body, body);
    if (message.includes("not provisioned")) assert(body.error.message.includes("no service owner"));
    assert(!JSON.stringify(body).includes("private"));
  });
}

for (const options of [{ lostRpc: true }, { badRpcResult: true }, { settleFails: true },
  { rpcError: { code: "08006", message: "connection lost" } },
  { rpcError: { code: "40003", message: "statement completion unknown" } },
]) {
  Deno.test(`uncertain registration ${JSON.stringify(options)} marks the owning claim indeterminate`, async () => {
    const db = database({ scopes: WRITE_SCOPES, ...options });
    const res = await handleRequest(mutation(), () => db.admin);
    assertEquals((await res.json()).error.code, "idempotency_indeterminate");
    assertEquals(db.settlements.at(-1)!.row.state, "indeterminate");
    assertEquals(db.settlements.at(-1)!.url.searchParams.get("attempt_token"), "eq.attempt-1");
  });
}

for (const [method, suffix, action] of [
  ["POST", "", "register_whatsapp_number"],
  ["POST", `/${ID}/pairing`, "create_whatsapp_pairing"],
  ["GET", `/${ID}/pairing`, "get_whatsapp_pairing"],
]) {
  for (const entitlement of [{ entitled: false }, { qrEntitled: false }]) {
    Deno.test(`${action} requires both features before any idempotency or binding`, async () => {
      const db = database({ scopes: WRITE_SCOPES, ...entitlement });
      const res = await handleRequest(method === "POST" ? mutation(suffix) : request(suffix), () => db.admin);
      assertEquals((await res.json()).error.code, "feature_not_entitled");
      assertEquals(db.claims.length, 0);
      assert(!db.reads.some((url) => /\/(social_accounts|partner_api_key_accounts)$/.test(url.pathname)));
      assertEquals(db.writes.find((write) => write.table === "partner_api_usage")!.row.action, action);
    });
  }
  Deno.test(`${action} refuses legacy scopes`, async () => {
    const db = database({ scopes: ["whatsapp:templates.read", "whatsapp:template.send", "whatsapp:webhooks.manage"] });
    const res = await handleRequest(method === "POST" ? mutation(suffix) : request(suffix), () => db.admin);
    assertEquals((await res.json()).error.code, "insufficient_scope");
  });
}

for (const method of ["GET", "POST"]) {
  Deno.test(`pairing ${method} refuses an unbound number without an account query`, async () => {
    const db = database({ scopes: WRITE_SCOPES });
    const suffix = `/${OTHER}/pairing`;
    const res = await handleRequest(method === "POST" ? mutation(suffix, {}) : request(suffix), () => db.admin);
    assertEquals((await res.json()).error.code, "resource_not_found");
    assert(!db.reads.some((url) => url.pathname.endsWith("/social_accounts")));
    if (method === "POST") { assertEquals(db.claims.length, 0); assertEquals(db.settlements.length, 0); }
  });
}

for (const scenario of ["success", "provider-uncertain", "settle-failed", "status"] as const) {
  Deno.test(`pairing route ${scenario} uses the provider and completes the correct claim lifecycle`, async () => {
    const db = database({ scopes: WRITE_SCOPES, settleFails: scenario === "settle-failed" });
    const savedFetch = globalThis.fetch;
    const savedEnv = ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"].map((name) => [name, Deno.env.get(name)] as const);
    const providerCalls: string[] = [];
    Deno.env.set("EVOLUTION_API_URL", "https://evolution.example");
    Deno.env.set("EVOLUTION_API_KEY", "provider-test-key");
    globalThis.fetch = (input) => {
      const url = String(input);
      assert(url.startsWith("https://evolution.example/instance/"));
      providerCalls.push(url);
      return scenario === "provider-uncertain" ? Promise.reject(new Error("response lost")) :
        Promise.resolve(Response.json(scenario === "status" ? { instance: { state: "open" } } :
          { qrcode: { base64: "pairing-image" }, state: "connecting" }));
    };
    try {
      const suffix = `/${ID}/pairing`;
      const res = await handleRequest(scenario === "status" ? request(suffix) : mutation(suffix, {}), () => db.admin);
      const body = await res.json();
      assertEquals(providerCalls.length, 1);
      if (scenario === "success") {
        assertEquals(res.status, 200);
        assertEquals(body.qr, { code: "pairing-image", expires_at: null });
        assertEquals(db.settlements[0].row.response_body, body);
        assertEquals(db.settlements[0].row.http_status, 200);
        assertEquals(db.settlements[0].url.searchParams.get("attempt_token"), "eq.attempt-1");
        const replay = await handleRequest(mutation(suffix, {}), () => db.admin);
        assertEquals(await replay.json(), body);
        assertEquals(providerCalls.length, 1);
      } else if (scenario === "status") {
        assertEquals(res.status, 200);
        assertEquals(body.state, "open");
        assertEquals(body.phone_number, ROW.platform_user_id);
        assertEquals(db.claims.length, 0);
        assertEquals(db.settlements.length, 0);
      } else {
        assertEquals(body.error.code, "idempotency_indeterminate");
        assertEquals(db.settlements.at(-1)!.row.state, "indeterminate");
        assertEquals(db.settlements.at(-1)!.url.searchParams.get("attempt_token"), "eq.attempt-1");
      }
      const usage = db.writes.find((write) => write.table === "partner_api_usage")!.row;
      assertEquals(usage.action, scenario === "status" ? "get_whatsapp_pairing" : "create_whatsapp_pairing");
    } finally {
      globalThis.fetch = savedFetch;
      for (const [name, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(name);
        else Deno.env.set(name, value);
      }
    }
  });
}

Deno.test("pairing status fails closed on a limiter outage before provider or account reads", async () => {
  const db = database({ scopes: WRITE_SCOPES, limiterFails: true });
  const res = await handleRequest(request(`/${ID}/pairing`), () => db.admin);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, "limiter_unavailable");
  assertEquals(db.reads.length, 1);
});

Deno.test("missing pairing configuration settles a definite refusal without provider writes", async () => {
  const db = database({ scopes: WRITE_SCOPES });
  const saved = Deno.env.get("EVOLUTION_API_URL");
  Deno.env.delete("EVOLUTION_API_URL");
  try {
    const res = await handleRequest(mutation(`/${ID}/pairing`, {}), () => db.admin);
    assertEquals((await res.json()).error.code, "internal_error");
    assertEquals(db.settlements[0].row.state, "completed");
    assertEquals(db.settlements[0].row.http_status, 500);
    assert(!db.writes.some((write) => write.table === "whatsapp_evolution_instances"));
  } finally {
    if (saved !== undefined) Deno.env.set("EVOLUTION_API_URL", saved);
  }
});

for (const [method, resource, action] of [
  ["DELETE", "session", "end_whatsapp_session"],
  ["GET", "history-sync", "get_whatsapp_history_sync"],
  ["POST", "history-sync", "start_whatsapp_history_sync"],
]) {
  Deno.test(`${action} refuses entitlement and unbound accounts with a usage row`, async () => {
    for (const entitled of [false, true]) {
      const db = database({ scopes: WRITE_SCOPES, entitled });
      const suffix = `/${entitled ? OTHER : ID}/${resource}`;
      const res = await handleRequest(method === "GET" ? request(suffix) : mutation(suffix, {}, "key", method), () => db.admin);
      const code = entitled ? "resource_not_found" : "feature_not_entitled";
      assertEquals((await res.json()).error.code, code);
      assertEquals(db.reads.filter((url) => url.pathname.endsWith("/social_accounts")).length, entitled ? 0 : 1);
      if (!entitled) assertEquals(db.claims.length, 0);
      const usage = db.writes.find((write) => write.table === "partner_api_usage")!.row;
      assertEquals(usage.action, action);
      assertEquals(usage.error_code, code);
    }
  });
}

for (const claim of ["replay", "conflict", "in_progress", "indeterminate"]) {
  Deno.test(`session DELETE handles ${claim} without teardown`, async () => {
    const db = database({ scopes: WRITE_SCOPES, claim });
    const res = await claimWithoutDispatch(db, mutation(`/${ID}/session`, {}, "key", "DELETE"), true);
    const body = await res.json();
    if (claim === "replay") {
      assertEquals(res.status, 202);
      assertEquals(body.saved, "original outcome");
      assertEquals(res.headers.get("Idempotency-Replayed"), "true");
    } else assertEquals(body.error.code, `idempotency_${claim}`);
  });
}

for (const scenario of ["remote-failed", "remote-ok", "deactivation-failed", "settlement-failed"] as const) {
  Deno.test(`session DELETE ${scenario} reports and persists its actual outcome`, async () => {
    const db = database({ scopes: WRITE_SCOPES, deactivationFails: scenario === "deactivation-failed", settleFails: scenario === "settlement-failed" });
    const savedFetch = globalThis.fetch;
    const savedEnv = ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"].map((name) => [name, Deno.env.get(name)] as const);
    const calls: string[] = [];
    Deno.env.set("EVOLUTION_API_URL", "https://evolution.example");
    Deno.env.set("EVOLUTION_API_KEY", "provider-test-key");
    globalThis.fetch = (input) => {
      calls.push(String(input));
      return scenario === "remote-failed" ? Promise.reject(new Error("private provider token")) : Promise.resolve(Response.json({}));
    };
    try {
      const req = () => mutation(`/${ID}/session`, {}, "key", "DELETE");
      const res = await handleRequest(req(), () => db.admin);
      const body = await res.json();
      assertEquals(calls.length, 2);
      if (scenario === "remote-failed" || scenario === "remote-ok") {
        assertEquals(res.status, 200);
        assertEquals(body.local_deactivated, true);
        assertEquals(body.remote_logout, scenario === "remote-failed" ? "failed" : "ok");
        assertEquals(body.warnings.length > 0, scenario === "remote-failed");
        assertEquals(body.request_id, res.headers.get("X-Postora-Request-Id"));
        assertEquals(db.settlements[0].row.state, "completed");
        assertEquals(db.settlements[0].row.response_body, body);
        assertEquals(await (await handleRequest(req(), () => db.admin)).json(), body);
        assertEquals(calls.length, 2);
      } else {
        assertEquals(res.status, 409);
        assertEquals(body.error.code, "idempotency_indeterminate");
        assertEquals(db.settlements.at(-1)!.row.state, "indeterminate");
      }
      assert(!JSON.stringify(body).includes("private"));
      assertEquals(db.settlements.at(-1)!.url.searchParams.get("attempt_token"), "eq.attempt-1");
    } finally {
      globalThis.fetch = savedFetch;
      for (const [name, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value);
      }
    }
  });
}

Deno.test("a teardown returning deactivated false cannot produce a 200", async () => {
  const db = database({ scopes: WRITE_SCOPES });
  const handler = withPartnerAuth("end_whatsapp_session", "C", (req, ctx, params) => endSessionRoute(req, ctx, params, {
    disconnect: () => Promise.resolve({ deactivated: false, evolution: "ok", graph: "skipped", warnings: [] }),
  }), () => db.admin);
  const res = await handler(mutation(`/${ID}/session`, {}, "key", "DELETE"), "test-request", { id: ID });
  assertEquals(res.status, 500);
  assertEquals((await res.json()).error.code, "internal_error");
  assertEquals(db.settlements[0].row.state, "completed");
  assertEquals(db.writes.find((write) => write.table === "partner_api_usage")!.row.error_code, "internal_error");
});

Deno.test("history status remains a local class A read during a limiter outage", async () => {
  const db = database({ limiterFails: true, syncOutcome: { finished_at: "2026-09-10T11:00:00Z", error: "The import stopped unexpectedly. Try again in a minute." } });
  const res = await handleRequest(request(`/${ID}/history-sync`), () => db.admin);
  assertEquals(res.status, 200);
  assertEquals((await res.json()).state, "failed");
  assertEquals(db.claims.length, 0);
  assertEquals(db.settlements.length, 0);
});

for (const [scenario, options, expectedStatus, expectedCode] of [
  ["claimed", {}, 202, null],
  ["held lease", { leaseHeld: true }, 409, "sync_already_running"],
  ["unresolved number", { unresolved: true }, 422, "unsupported_capability"],
  ["missing workspace", { noWorkspace: true }, 500, "internal_error"],
  ["sweep throws", {}, 409, "idempotency_indeterminate"],
  ["settlement fails", { settleFails: true }, 409, "idempotency_indeterminate"],
  ["limiter outage", { limiterFails: true }, 503, "limiter_unavailable"],
] as const) {
  Deno.test(`history POST ${scenario} reports and settles the actual outcome`, async () => {
    const db = database({ scopes: WRITE_SCOPES, ...options });
    const savedFetch = globalThis.fetch;
    const savedEnv = ["EVOLUTION_API_URL", "EVOLUTION_API_KEY"].map((name) => [name, Deno.env.get(name)] as const);
    const calls: string[] = [];
    Deno.env.set("EVOLUTION_API_URL", "https://evolution.example");
    Deno.env.set("EVOLUTION_API_KEY", "test-key");
    globalThis.fetch = (input) => {
      const url = String(input);
      assert(url.startsWith("https://evolution.example/chat/"));
      calls.push(url);
      return scenario === "sweep throws" ? Promise.reject(new Error("private provider failure")) : Promise.resolve(Response.json([]));
    };
    try {
      // Exercise the real routed POST with no body as well as the {} replay.
      const req = new Request(`https://partner.example/functions/v1/partner-api/v1/whatsapp/numbers/${ID}/history-sync`, {
        method: "POST", headers: { "x-postora-key": "pk_live_test", "Idempotency-Key": "sync-key" },
      });
      const res = await handleRequest(req, () => db.admin);
      const body = await res.json();
      assertEquals(res.status, expectedStatus);
      if (expectedCode) {
        assertEquals(body.error.code, expectedCode);
        assertEquals(body.state, undefined);
        if (scenario === "held lease") assertEquals(body.error.retryable, true);
      } else assertEquals(body, { state: "running", request_id: res.headers.get("X-Postora-Request-Id") });
      assert(!JSON.stringify(body).includes("private"));
      const swept = ["claimed", "sweep throws", "settlement fails"].includes(scenario);
      assertEquals(calls.length, swept ? 2 : 0);
      const claims = db.writes.filter((write) => write.table === "claim_whatsapp_history_sync");
      assertEquals(claims.length, swept || scenario === "held lease" ? 1 : 0);
      const completions = db.writes.filter((write) => write.table === "whatsapp_evolution_instances");
      assertEquals(completions.length, swept ? 1 : 0);
      if (swept) assertEquals(completions[0].row.sync_started_at, null);
      if (scenario === "limiter outage") {
        assertEquals(db.claims.length, 0);
        assertEquals(db.settlements.length, 0);
      } else {
        const settled = db.settlements.at(-1)!;
        assertEquals(settled.url.searchParams.get("attempt_token"), "eq.attempt-1");
        assertEquals(settled.row.state, expectedCode === "idempotency_indeterminate" ? "indeterminate" : "completed");
        if (settled.row.state === "completed") {
          assertEquals(settled.row.http_status, expectedStatus);
          assertEquals(settled.row.response_body, body);
          const replay = await handleRequest(mutation(`/${ID}/history-sync`, {}, "sync-key"), () => db.admin);
          assertEquals(replay.status, expectedStatus);
          assertEquals(await replay.json(), body);
          assertEquals(replay.headers.get("Idempotency-Replayed"), "true");
          assertEquals(db.writes.filter((write) => write.table === "claim_whatsapp_history_sync").length, claims.length);
        }
      }
      const usage = db.writes.find((write) => write.table === "partner_api_usage")!.row;
      assertEquals(usage.action, "start_whatsapp_history_sync");
      assertEquals(usage.error_code ?? null, expectedCode);
    } finally {
      globalThis.fetch = savedFetch;
      for (const [name, value] of savedEnv) {
        if (value === undefined) Deno.env.delete(name); else Deno.env.set(name, value);
      }
    }
  });
}

Deno.test("history POST rejects unexpected body fields before the lease claim", async () => {
  const db = database({ scopes: WRITE_SCOPES });
  const res = await handleRequest(mutation(`/${ID}/history-sync`, { owner_id: "foreign-owner" }), () => db.admin);
  assertEquals((await res.json()).error.code, "invalid_request");
  assertEquals(db.writes.some((write) => write.table === "claim_whatsapp_history_sync"), false);
  assertEquals(db.settlements[0].row.http_status, 400);
});

for (const [body, key, expected] of [[{}, null, "missing_idempotency_key"], [{ unexpected: true }, "key", "invalid_request"]] as const) {
  Deno.test(`session DELETE rejects ${expected} before teardown`, async () => {
    const db = database({ scopes: WRITE_SCOPES });
    const res = await handleRequest(mutation(`/${ID}/session`, body, key, "DELETE"), () => db.admin);
    assertEquals((await res.json()).error.code, expected);
    assertEquals(db.reads.filter((url) => url.pathname.endsWith("/social_accounts")).length, key === null ? 0 : 1);
    assertEquals(db.writes.find((write) => write.table === "partner_api_usage")!.row.error_code, expected);
  });
}

for (const [method, resource] of [["DELETE", "session"], ["GET", "history-sync"], ["POST", "history-sync"]]) {
  Deno.test(`${method} ${resource} refuses legacy scopes and non-QR modes`, async () => {
    for (const legacy of [true, false]) {
      const db = database({ scopes: legacy ? ["whatsapp:template.send", "whatsapp:templates.read", "whatsapp:webhooks.manage"] : WRITE_SCOPES, mode: "cloud_api" });
      const suffix = `/${ID}/${resource}`;
      const res = await handleRequest(method === "GET" ? request(suffix) : mutation(suffix, {}, "key", method), () => db.admin);
      assertEquals((await res.json()).error.code, legacy ? "insufficient_scope" : "unsupported_capability");
      assert(!db.reads.some((url) => url.pathname.endsWith("/whatsapp_evolution_instances")));
    }
  });
}

const PROFILE_SCOPES = ["whatsapp:profile.read", "whatsapp:profile.manage"];
const profileRequest = (method: string, suffix = `/${ID}/profile`, body: unknown = { about: "New about" }, key: string | null = "profile-key") =>
  method === "GET" ? request(suffix) : mutation(suffix, body, key, method);

for (const method of ["GET", "PATCH"]) {
  const action = method === "GET" ? "get_whatsapp_profile" : "update_whatsapp_profile";
  Deno.test(`${method} profile entitlement refuses with its own action before account or idempotency reads`, async () => {
    const db = database({ scopes: PROFILE_SCOPES, entitled: false });
    const res = await handleRequest(profileRequest(method), () => db.admin);
    assertEquals((await res.json()).error.code, "feature_not_entitled");
    assert(!db.reads.some((url) => /\/(social_accounts|partner_api_key_accounts)$/.test(url.pathname)));
    assertEquals(db.claims.length, 0);
    assertEquals(db.writes.find((write) => write.table === "partner_api_usage")?.row.action, action);
    assertEquals((db.writes.find((write) => write.table === "system_logs")?.row.metadata as Record<string, unknown>).action, action);
  });

  for (const suffix of [`/${OTHER}/profile`, `/${ID}/profile?account_id=${OTHER}`]) {
    Deno.test(`${method} profile unbound path/query ${suffix} refuses before querying an account`, async () => {
      const db = database({ scopes: PROFILE_SCOPES });
      const res = await handleRequest(profileRequest(method, suffix), () => db.admin);
      assertEquals(res.status, 404);
      assertEquals((await res.json()).error.code, "resource_not_found");
      assert(!db.reads.some((url) => url.pathname.endsWith("/social_accounts")));
      assertEquals(db.claims.length, 0);
      assertEquals(db.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "resource_not_found");
    });
  }

  for (const [accountPatch, code] of [
    [{ needs_reauth: true }, "account_needs_reauth"],
    [{ token_expires_at: "2000-01-01T00:00:00Z" }, "account_needs_reauth"],
    [{ platform: "facebook" }, "account_not_connected"],
    [{ is_active: false }, "account_not_connected"],
  ] as const) {
    Deno.test(`${method} profile preflight surfaces ${JSON.stringify(accountPatch)}`, async () => {
      const db = database({ scopes: PROFILE_SCOPES, accountPatch });
      const res = await handleRequest(profileRequest(method), () => db.admin);
      assertEquals((await res.json()).error.code, code);
      assertEquals(db.claims.length, 0);
      assertEquals(db.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, code);
    });
  }

  Deno.test(`${method} profile QR refusal is logged as unsupported_capability`, async () => {
    const db = database({ scopes: PROFILE_SCOPES });
    const res = await handleRequest(profileRequest(method), () => db.admin);
    assertEquals(res.status, 422);
    const body = await res.json();
    assertEquals(body.error.code, "unsupported_capability");
    assert(body.error.message.includes("Cloud API capability"));
    assertEquals(db.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "unsupported_capability");
  });

  Deno.test(`${method} profile fails closed on limiter outage`, async () => {
    const db = database({ scopes: PROFILE_SCOPES, limiterFails: true });
    const res = await handleRequest(profileRequest(method), () => db.admin);
    assertEquals(res.status, 503);
    assertEquals((await res.json()).error.code, "limiter_unavailable");
    assertEquals(db.reads.length, 1);
  });

  for (const failTable of ["partner_api_key_accounts", "social_accounts"]) {
    Deno.test(`${method} profile ${failTable} read errors are logged failures`, async () => {
      const db = database({ scopes: PROFILE_SCOPES, failTable });
      const res = await handleRequest(profileRequest(method), () => db.admin);
      assertEquals(res.status, 500);
      assertEquals((await res.json()).error.code, "internal_error");
      assertEquals(db.claims.length, 0);
      assertEquals(db.writes.find((write) => write.table === "partner_api_usage")?.row.error_code, "internal_error");
    });
  }

  Deno.test(`${method} profile does not inherit legacy or number scopes`, async () => {
    const db = database({ scopes: [...WRITE_SCOPES, "whatsapp:templates.read", "whatsapp:template.send"] });
    const res = await handleRequest(profileRequest(method), () => db.admin);
    assertEquals((await res.json()).error.code, "insufficient_scope");
    assertEquals(db.reads.length, 1);
  });
}

for (const claim of ["replay", "conflict", "in_progress", "indeterminate"]) {
  Deno.test(`profile PATCH ${claim} avoids provider dispatch and settlement`, async () => {
    const db = database({ scopes: PROFILE_SCOPES, claim, mode: "cloud_api" });
    const res = await handleRequest(profileRequest("PATCH"), () => db.admin);
    const body = await res.json();
    if (claim === "replay") {
      assertEquals(res.status, 202);
      assertEquals(body, { saved: "original outcome", request_id: "original-request" });
      assertEquals(res.headers.get("Idempotency-Replayed"), "true");
    } else assertEquals(body.error.code, `idempotency_${claim}`);
    assertEquals(db.settlements.length, 0);
  });
}

Deno.test("profile PATCH requires idempotency and settles an empty patch as a definite refusal", async () => {
  for (const key of [null, "key"]) {
    const db = database({ scopes: PROFILE_SCOPES, mode: "cloud_api" });
    const res = await handleRequest(profileRequest("PATCH", undefined, {}, key), () => db.admin);
    assertEquals((await res.json()).error.code, key === null ? "missing_idempotency_key" : "invalid_request");
    assertEquals(db.settlements.length, key === null ? 0 : 1);
    if (key) assertEquals(db.settlements[0].row.state, "completed");
  }
});

for (const scenario of ["get", "update", "rejected", "5xx", "unparseable", "settle-failed"]) {
  Deno.test(`profile ${scenario} preserves provider and idempotency outcomes with QR flag disabled`, async () => {
    const db = database({ scopes: PROFILE_SCOPES, mode: "cloud_api", qrEntitled: false, settleFails: scenario === "settle-failed" });
    const savedFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (input, init) => {
      calls.push(String(input));
      assert(String(input).startsWith(`https://graph.facebook.com/v21.0/${ROW.platform_user_id}/whatsapp_business_profile`));
      if (scenario !== "get") assertEquals(JSON.parse(String(init?.body)), { messaging_product: "whatsapp", about: "New about" });
      return Promise.resolve(scenario === "get" ? Response.json({ data: [{ about: "Current about" }] }) :
        scenario === "unparseable" ? new Response("broken response") :
        scenario === "5xx" ? Response.json({ error: { code: 2 } }, { status: 503 }) :
        scenario === "rejected" ? Response.json({ error: { code: 100, message: "private details" } }, { status: 400 }) :
        Response.json({ success: true }));
    };
    try {
      const send = () => profileRequest(scenario === "get" ? "GET" : "PATCH", `/${ID}/profile?account_id=${ID}`);
      const res = await handleRequest(send(), () => db.admin);
      const body = await res.json();
      assertEquals(calls.length, 1);
      const accountRead = db.reads.find((url) => url.pathname.endsWith("/social_accounts"))!;
      assertEquals(accountRead.searchParams.get("id"), `eq.${ID}`); // primary account is OTHER
      const binding = db.reads.find((url) => url.pathname.endsWith("/partner_api_key_accounts"))!;
      assertEquals(binding.searchParams.get("workspace_id"), "eq.ws-1");
      assertEquals(binding.searchParams.get("key_id"), "eq.key-1");
      assertEquals(binding.searchParams.get("social_account_id"), `eq.${ID}`);
      if (scenario === "get") {
        assertEquals(res.status, 200);
        assertEquals(body.about, "Current about");
        assertEquals(body.websites, []);
        assertEquals(db.claims.length, 0);
      } else if (scenario === "update" || scenario === "rejected") {
        assertEquals(res.status, scenario === "update" ? 200 : 422);
        if (scenario === "update") assertEquals(body.success, true);
        else assertEquals(body.error.code, "meta_error");
        assertEquals(db.settlements[0].row.state, "completed");
        assertEquals(db.settlements[0].url.searchParams.get("attempt_token"), "eq.attempt-1");
        assertEquals(await (await handleRequest(send(), () => db.admin)).json(), body);
        assertEquals(calls.length, 1);
        const conflict = await handleRequest(profileRequest("PATCH", undefined, { about: "Different" }), () => db.admin);
        assertEquals((await conflict.json()).error.code, "idempotency_conflict");
      } else {
        assertEquals(res.status, 409);
        assertEquals(body.error.code, "idempotency_indeterminate");
        assertEquals(body.error.retryable, false);
        assertEquals(db.settlements.at(-1)!.row.state, "indeterminate");
      }
      assert(!JSON.stringify(body).includes("private details"));
    } finally {
      globalThis.fetch = savedFetch;
    }
  });
}
