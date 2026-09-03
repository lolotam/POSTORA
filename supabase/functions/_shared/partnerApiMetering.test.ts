// deno-lint-ignore-file no-import-prefix
import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { PartnerAuthError } from "./partnerApiKeys.ts";
import {
  checkRateLimit,
  RateLimitedError,
  recordUsage,
  releaseQuota,
  reserveQuota,
} from "./partnerApiMetering.ts";

const RECORD = {
  id: "key-1", workspaceId: "ws-1", socialAccountId: "acct-1",
  keyPrefix: "pk_live_abcd", scopes: ["whatsapp:template.send"],
  rateLimitPerMin: 60, monthlyQuota: 100, expiresAt: null, revokedAt: null,
};

function stubRpc(result: { allowed: boolean; usage_count: number }) {
  return {
    rpc() { return Promise.resolve({ data: [result], error: null }); },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("reserveQuota returns true when the key is under quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: true, usage_count: 5 }), RECORD), true);
});

Deno.test("reserveQuota returns false when the reservation exceeds quota", async () => {
  assertEquals(await reserveQuota(stubRpc({ allowed: false, usage_count: 101 }), RECORD), false);
});

Deno.test("releaseQuota refunds a reservation without throwing", async () => {
  let called = false;
  const client = { rpc() { called = true; return Promise.resolve({ error: null }); } } as any;
  await releaseQuota(client, RECORD);
  assertEquals(called, true);
});

Deno.test("recordUsage writes one row with the billable flag it was given", async () => {
  const inserted: unknown[] = [];
  const client = {
    from() {
      return { insert(row: unknown) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;

  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });

  assertEquals(inserted.length, 1);
  assertEquals((inserted[0] as Record<string, unknown>).billable, true);
  assertEquals((inserted[0] as Record<string, unknown>).action, "send_template");
});

Deno.test("recordUsage never throws — metering must not fail a real send", async () => {
  const client = {
    from() {
      return { insert() { return Promise.resolve({ error: { message: "boom" } }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "send_template",
    billable: true, httpStatus: 200,
  });
});

// ---- D7 limiter-failure policy -------------------------------------------
// The RPC erroring is the limiter being UNAVAILABLE — a different path from
// the limit being exceeded, which must keep refusing with 429 rate_limited.

function limiterUnavailableClient() {
  return {
    rpc() { return Promise.resolve({ data: null, error: { message: "connection refused" } }); },
  // deno-lint-ignore no-explicit-any
  } as any;
}

/** A client whose RPC answers successfully with the given v2 row. */
function limiterClient(data: unknown) {
  return {
    rpc() { return Promise.resolve({ data, error: null }); },
  // deno-lint-ignore no-explicit-any
  } as any;
}

Deno.test("checkRateLimit: class A proceeds when the limiter RPC errors (fail open)", async () => {
  // Must resolve, not throw — a bounded local read survives a limiter
  // outage — and must report "unavailable" so the caller emits no budget
  // headers for a budget that was never resolved.
  assertEquals(await checkRateLimit(limiterUnavailableClient(), RECORD, "A"), { status: "unavailable" });
});

Deno.test("checkRateLimit: class B fails closed with 503 limiter_unavailable", async () => {
  const error = await assertRejects(
    () => checkRateLimit(limiterUnavailableClient(), RECORD, "B"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("checkRateLimit: class C fails closed with 503 limiter_unavailable", async () => {
  const error = await assertRejects(
    () => checkRateLimit(limiterUnavailableClient(), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("checkRateLimit: an unclassified action fails closed, never fail-open by default", async () => {
  // undefined = nobody chose a class for this action. Assuming the worst is
  // the only safe default: failing open here would recreate the bug D7 fixes.
  const error = await assertRejects(
    () => checkRateLimit(limiterUnavailableClient(), RECORD, undefined),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

// ---- the v2 verdict: what counts as "the limiter answered" -----------------

Deno.test("checkRateLimit: an allowed v2 row resolves with the numbers the RPC reported", async () => {
  assertEquals(
    await checkRateLimit(limiterClient({ allowed: true, remaining: 59, reset_seconds: 42 }), RECORD, "A"),
    { status: "resolved", limit: 60, remaining: 59, resetSeconds: 42 },
  );
});

Deno.test("checkRateLimit: a one-element-array row (older PostgREST shape) still resolves", async () => {
  assertEquals(
    await checkRateLimit(limiterClient([{ allowed: true, remaining: 3, reset_seconds: 60 }]), RECORD, "A"),
    { status: "resolved", limit: 60, remaining: 3, resetSeconds: 60 },
  );
});

Deno.test("checkRateLimit: a refused v2 row throws rate_limited carrying the database reset", async () => {
  const error = await assertRejects(
    () => checkRateLimit(limiterClient({ allowed: false, remaining: 0, reset_seconds: 30 }), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error instanceof RateLimitedError, true);
  assertEquals(error.code, "rate_limited");
  assertEquals(error.status, 429);
  assertEquals((error as RateLimitedError).resetSeconds, 30);
});

Deno.test("checkRateLimit: a refusal without a usable reset still refuses, publishing no number", async () => {
  // A drifted shape must not weaken the refusal itself: it is still a 429,
  // but with no reset to hand the caller the error carries null so the
  // handler omits Reset/Retry-After instead of inventing them.
  const error = await assertRejects(
    () => checkRateLimit(limiterClient({ allowed: false, remaining: 0, reset_seconds: 0 }), RECORD, "C"),
    RateLimitedError,
  );
  assertEquals(error.code, "rate_limited");
  assertEquals(error.resetSeconds, null);
});

// ---- the hardening: anything but the exact v2 shape is "unavailable" ------
// These are the regression tests for the literal-`true`/literal-`false` rule
// carried from the v1 boolean into the v2 record: a null, a bare boolean, or
// a drifted record must be indistinguishable from the limiter being down —
// never an allow.

Deno.test("checkRateLimit: data null with no error fails closed for class C", async () => {
  const error = await assertRejects(
    () => checkRateLimit(limiterClient(null), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("checkRateLimit: data null with no error fails open for class A only", async () => {
  assertEquals(await checkRateLimit(limiterClient(null), RECORD, "A"), { status: "unavailable" });
});

Deno.test("checkRateLimit: a v1-shaped bare boolean is not a budget — class C fails closed", async () => {
  // The old consume_partner_rate shape. Deployed edge code must never treat
  // it as "allowed with numbers", because it carries no numbers.
  const error = await assertRejects(
    () => checkRateLimit(limiterClient(true), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
});

Deno.test("checkRateLimit: an object without a boolean allowed fails closed for class C", async () => {
  const error = await assertRejects(
    () => checkRateLimit(limiterClient({ remaining: 59, reset_seconds: 42 }), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
});

Deno.test("checkRateLimit: an allowed row with missing numbers is not a resolution", async () => {
  // `allowed: true` without real remaining/reset would force the response to
  // invent a budget — the exact thing this rework removed.
  const error = await assertRejects(
    () => checkRateLimit(limiterClient({ allowed: true }), RECORD, "C"),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
});

Deno.test("checkRateLimit: an allowed row with out-of-range numbers is not a resolution", async () => {
  // The real function mathematically returns remaining >= 0 and reset in
  // 1..60. 0, 61 and a fraction are values it cannot produce, so they must
  // not be published as if it had.
  for (const bad of [
    { allowed: true, remaining: -1, reset_seconds: 42 },
    { allowed: true, remaining: 59, reset_seconds: 0 },
    { allowed: true, remaining: 59, reset_seconds: 61 },
    { allowed: true, remaining: 59, reset_seconds: 1.5 },
  ]) {
    const error = await assertRejects(
      () => checkRateLimit(limiterClient(bad), RECORD, "C"),
      PartnerAuthError,
    );
    assertEquals(error.code, "limiter_unavailable");
    assertEquals(error.status, 503);
  }
});

Deno.test("checkRateLimit: a multi-row result is drift, not an allow", async () => {
  // Reading data[0] out of an array of any length silently discards the rest,
  // so a two-row answer whose FIRST row says allowed:true would be read as an
  // allow -- and a class C send would proceed on a limiter result that is not
  // the v2 contract. consume_partner_rate_v2 returns exactly one row, so more
  // than one is evidence the answer came from something else.
  const error = await assertRejects(
    () =>
      checkRateLimit(
        limiterClient([
          { allowed: true, remaining: 59, reset_seconds: 42 },
          { allowed: false, remaining: 0, reset_seconds: 42 },
        ]),
        RECORD,
        "C",
      ),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("checkRateLimit: remaining EQUAL to the limit is impossible, so it is drift", async () => {
  // The boundary, tested because a `> limit` bound looks right and is not.
  // remaining is GREATEST(limit - count, 0) and the row this call just
  // consumed makes count >= 1, so limit - 1 is the largest value the real
  // function can produce. remaining === limit describes a window nothing was
  // charged to. RECORD's limit is 60.
  const error = await assertRejects(
    () =>
      checkRateLimit(
        limiterClient({ allowed: true, remaining: 60, reset_seconds: 42 }),
        RECORD,
        "C",
      ),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

Deno.test("checkRateLimit: remaining of limit - 1 is the real maximum and still resolves", async () => {
  // The other side of the same boundary: tightening the bound must not start
  // rejecting the largest value the function legitimately returns, which is
  // what a fencepost fix gets wrong in the opposite direction.
  const decision = await checkRateLimit(
    limiterClient({ allowed: true, remaining: 59, reset_seconds: 42 }),
    RECORD,
    "C",
  );
  assertEquals(decision.status, "resolved");
});

Deno.test("checkRateLimit: remaining above the key's own limit is impossible, so it is drift", async () => {
  // remaining is GREATEST(limit - count, 0) with count >= 1, so the real
  // function can never return more than limit - 1. A larger number cannot have
  // come from it, and publishing it would tell a partner they have more budget
  // than exists. RECORD's limit is 60.
  const error = await assertRejects(
    () =>
      checkRateLimit(
        limiterClient({ allowed: true, remaining: 999, reset_seconds: 42, extra: "drift" }),
        RECORD,
        "C",
      ),
    PartnerAuthError,
  );
  assertEquals(error.code, "limiter_unavailable");
  assertEquals(error.status, 503);
});

// ---- ledger request_id / latency_ms (admin partner hub, spec D4) -----------

Deno.test("recordUsage writes request_id and latency_ms when given", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts",
    billable: false, httpStatus: 200, requestId: "req-42", latencyMs: 17,
  });
  assertEquals(inserted[0].request_id, "req-42");
  assertEquals(inserted[0].latency_ms, 17);
});

Deno.test("recordUsage writes null for request_id and latency_ms when absent", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts", billable: false, httpStatus: 200,
  });
  assertEquals(inserted[0].request_id, null);
  assertEquals(inserted[0].latency_ms, null);
});

Deno.test("recordUsage rounds latency to a non-negative integer", async () => {
  const inserted: Record<string, unknown>[] = [];
  const client = {
    from() {
      return { insert(row: Record<string, unknown>) { inserted.push(row); return Promise.resolve({ error: null }); } };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
  await recordUsage(client, {
    keyId: "key-1", workspaceId: "ws-1", action: "list_accounts",
    billable: false, httpStatus: 200, latencyMs: -0.4,
  });
  assertEquals(inserted[0].latency_ms, 0);
});
