// deno-lint-ignore-file no-import-prefix
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { handleRequest } from "../index.ts";
import { decodeCursor } from "./pagination.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "11111111-1111-4111-8111-111111111111";
const ROW = {
  id: ID, workspace_id: "ws-1", platform: "whatsapp", platform_user_id: "15550001111",
  platform_username: "Support", connection_mode: "evolution_qr", account_metadata: {},
  is_active: true, connected_at: "2026-09-01T00:00:00Z", updated_at: "2026-09-10T00:00:00Z",
};

function database(opts: {
  entitled?: boolean; qrEntitled?: boolean; scopes?: string[]; failTable?: string;
  claim?: string; rpcError?: { code: string; message: string }; lostRpc?: boolean;
  badRpcResult?: boolean; settleFails?: boolean;
  limiterFails?: boolean;
} = {}) {
  const reads: URL[] = [];
  const writes: Array<{ table: string; row: Record<string, unknown> }> = [];
  const claims: Record<string, unknown>[] = [];
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
      if (table === "partner_api_idempotency" && init?.method === "PATCH") {
        const row = JSON.parse(String(init.body));
        settlements.push({ url, row });
        if (row.state === "completed" && opts.settleFails) return Promise.resolve(Response.json({ message: "settle failed" }, { status: 500 }));
        settled = row;
        return Promise.resolve(new Response(null, { status: 204 }));
      }
      if (table === "whatsapp_evolution_instances" && init?.method === "PATCH") {
        writes.push({ table, row: JSON.parse(String(init.body)) });
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
          { key: "feature_wa_evolution_qr_enabled", value: opts.qrEntitled ?? true }],
        user_feature_overrides: [],
        partner_api_key_accounts: [{ social_account_id: ID }],
        social_accounts: url.searchParams.get("id")?.startsWith("eq.") ? [ROW] :
          [ROW, { ...ROW, id: OTHER }],
        whatsapp_evolution_instances: [{ instance_name: `postora_${ID}`, jwt_key: "private-key", last_qr: null }],
      };
      assert(Object.hasOwn(rows, table), `unexpected read of ${table}`);
      return Promise.resolve(Response.json(rows[table]));
    } },
  });
  return { admin, reads, writes, claims, settlements };
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
function mutation(suffix = "", body: unknown = REGISTRATION, key: string | null = "registration-key") {
  return new Request(`https://partner.example/functions/v1/partner-api/v1/whatsapp/numbers${suffix}`, {
    method: "POST", headers: { "x-postora-key": "pk_live_test", "Content-Type": "application/json",
      ...(key === null ? {} : { "Idempotency-Key": key }) }, body: JSON.stringify(body),
  });
}

for (const suffix of ["", `/${ID}/pairing`]) {
  for (const claim of ["replay", "conflict", "in_progress", "indeterminate"]) {
    Deno.test(`write ${suffix || "registration"} handles ${claim} without dispatch`, async () => {
      const db = database({ scopes: WRITE_SCOPES, claim });
      const res = await handleRequest(mutation(suffix, suffix ? {} : REGISTRATION), () => db.admin);
      const body = await res.json();
      if (claim === "replay") {
        assertEquals(res.status, 202);
        assertEquals(body, { saved: "original outcome", request_id: "original-request" });
        assertEquals(res.headers.get("Idempotency-Replayed"), "true");
      } else assertEquals(body.error.code, `idempotency_${claim}`);
      assert(!db.writes.some((write) => write.table === "register_partner_whatsapp_number"));
      assert(!db.reads.some((url) => url.pathname.endsWith("/social_accounts")));
      assertEquals(db.settlements.length, 0);
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
    if (method === "POST") assertEquals(db.settlements[0].row.http_status, 404);
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
