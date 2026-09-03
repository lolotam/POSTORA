// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withPartnerAuth } from "./authenticated.ts";
import { v1ErrorResponse } from "./errors.ts";

// ---------------------------------------------------------------------------
// Phase 10.1 — the centralised usage ledger in withPartnerAuth.
//
// Before this, no /v1 route wrote partner_api_usage at all; only the frozen
// alias did. The property under test is attribution: every response produced
// once the key is KNOWN leaves exactly one row against that key, and a
// response produced before the key resolved leaves none — a ledger row for an
// unknown key would be a probe's evidence that the key exists.
// ---------------------------------------------------------------------------

const KEY_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["accounts:read", "messages:send"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

/** The ledger row without the fields this suite does not assert on
 *  (latency is wall-clock; request_id is asserted in its own test). */
function comparable(rows: Record<string, unknown>[]) {
  return rows.map(({ latency_ms: _l, request_id: _r, ...rest }) => rest);
}

interface StubOpts {
  keyRow?: unknown;
  limiter?: { data: unknown; error: unknown };
}

/** A Supabase stub that answers the key lookup and the limiter, and records
 *  every partner_api_usage insert. */
function ledgerStub(opts: StubOpts = {}) {
  const inserts: Record<string, unknown>[] = [];
  const limiter = opts.limiter ??
    { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };
  const keyRow = opts.keyRow !== undefined ? opts.keyRow : KEY_ROW;
  const admin = {
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_api_usage") {
        return {
          insert(row: Record<string, unknown>) {
            inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: keyRow, error: null }); },
      };
    },
  };
  return { admin, inserts };
}

const ok = () => Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));

function get(key: string) {
  return new Request("https://partner.example/functions/v1/partner-api/v1/accounts", {
    method: "GET",
    headers: { "x-postora-key": key },
  });
}

Deno.test("a 200 from a class-A read leaves one non-billable row with no error code", async () => {
  const { admin, inserts } = ledgerStub();
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-1", {}, () => admin);
  assertEquals(res.status, 200);
  assertEquals(comparable(inserts), [{
    key_id: KEY_ROW.id,
    workspace_id: KEY_ROW.workspace_id,
    action: "list_accounts",
    billable: false,
    http_status: 200,
    error_code: null,
  }]);
});

Deno.test("a handler's typed error is recorded by its code, not just its status", async () => {
  const { admin, inserts } = ledgerStub();
  const notFound = (_req: Request, authed: { requestId: string }) =>
    Promise.resolve(v1ErrorResponse("resource_not_found", authed.requestId));
  const wrapped = withPartnerAuth("list_accounts", "A", notFound, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-2", {}, () => admin);
  assertEquals(res.status, 404);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].error_code, "resource_not_found");
  assertEquals(inserts[0].http_status, 404);
});

Deno.test("an unknown key leaves no row: there is nothing to attribute it to", async () => {
  const { admin, inserts } = ledgerStub({ keyRow: null });
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  const res = await wrapped(get("pk_live_nope"), "req-3", {}, () => admin);
  assertEquals(res.status, 401);
  assertEquals(inserts.length, 0);
});

Deno.test("a scope refusal is recorded against the key that was refused", async () => {
  const { admin, inserts } = ledgerStub({ keyRow: { ...KEY_ROW, scopes: [] } });
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-4", {}, () => admin);
  assertEquals(res.status, 403);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].error_code, "insufficient_scope");
});

Deno.test("a limiter refusal is recorded as rate_limited against the key", async () => {
  const { admin, inserts } = ledgerStub({
    limiter: { data: { allowed: false, remaining: 0, reset_seconds: 30 }, error: null },
  });
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-5", {}, () => admin);
  assertEquals(res.status, 429);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].error_code, "rate_limited");
  assertEquals(inserts[0].http_status, 429);
});

Deno.test("a limiter refusal publishes the budget the contract promises: Limit, Remaining 0, Reset and Retry-After", async () => {
  const { admin } = ledgerStub({
    limiter: { data: { allowed: false, remaining: 0, reset_seconds: 30 }, error: null },
  });
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-5b", {}, () => admin);
  assertEquals(res.status, 429);
  assertEquals(res.headers.get("X-RateLimit-Limit"), String(KEY_ROW.rate_limit_per_min));
  assertEquals(res.headers.get("X-RateLimit-Remaining"), "0");
  assertEquals(res.headers.get("X-RateLimit-Reset"), "30");
  assertEquals(res.headers.get("Retry-After"), "30");

  // A refusal whose reset the RPC did not compute publishes Remaining 0 and
  // nothing invented for Reset or Retry-After.
  const noReset = ledgerStub({ limiter: { data: { allowed: false }, error: null } });
  const wrappedNoReset = withPartnerAuth("list_accounts", "A", ok, () => noReset.admin);
  const bare = await wrappedNoReset(get("pk_live_test"), "req-5c", {}, () => noReset.admin);
  assertEquals(bare.status, 429);
  assertEquals(bare.headers.get("X-RateLimit-Remaining"), "0");
  assertEquals(bare.headers.get("X-RateLimit-Reset"), null);
  assertEquals(bare.headers.get("Retry-After"), null);
});

Deno.test("a quota-reserving action's 2xx is billable; its refusal is not", async () => {
  const sendKey = { ...KEY_ROW, scopes: ["messages:send"] };
  const accepted = ledgerStub({ keyRow: sendKey });
  const wrappedOk = withPartnerAuth("send_template", "C", ok, () => accepted.admin);
  await wrappedOk(get("pk_live_test"), "req-6", {}, () => accepted.admin);
  assertEquals(accepted.inserts[0].billable, true);
  assertEquals(accepted.inserts[0].action, "send_template");

  const refused = ledgerStub({ keyRow: sendKey });
  const quotaExceeded = (_req: Request, authed: { requestId: string }) =>
    Promise.resolve(v1ErrorResponse("quota_exceeded", authed.requestId));
  const wrappedNo = withPartnerAuth("send_template", "C", quotaExceeded, () => refused.admin);
  await wrappedNo(get("pk_live_test"), "req-7", {}, () => refused.admin);
  assertEquals(refused.inserts[0].billable, false);
  assertEquals(refused.inserts[0].error_code, "quota_exceeded");
});

Deno.test("a replayed 2xx is recorded but never billed: nothing was reserved or sent again", async () => {
  const sendKey = { ...KEY_ROW, scopes: ["messages:send"] };
  const { admin, inserts } = ledgerStub({ keyRow: sendKey });
  const replay = () => {
    const res = new Response(JSON.stringify({ success: true }), { status: 200 });
    res.headers.set("Idempotency-Replayed", "true");
    return Promise.resolve(res);
  };
  const wrapped = withPartnerAuth("send_template", "C", replay, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-9", {}, () => admin);
  assertEquals(res.status, 200);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].billable, false);
  assertEquals(inserts[0].http_status, 200);
});

Deno.test("a handler that throws is answered internal_error and still recorded", async () => {
  const { admin, inserts } = ledgerStub();
  const boom = () => Promise.reject(new Error("handler exploded"));
  const wrapped = withPartnerAuth("list_accounts", "A", boom, () => admin);
  const res = await wrapped(get("pk_live_test"), "req-8", {}, () => admin);
  assertEquals(res.status, 500);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].error_code, "internal_error");
});

Deno.test("every ledger row carries the request id and a non-negative integer latency", async () => {
  const { admin, inserts } = ledgerStub();
  const wrapped = withPartnerAuth("list_accounts", "A", ok, () => admin);
  await wrapped(get("pk_live_test"), "req-77", {}, () => admin);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].request_id, "req-77");
  const latency = inserts[0].latency_ms;
  assertEquals(typeof latency, "number");
  assertEquals(Number.isInteger(latency) && (latency as number) >= 0, true);
});
