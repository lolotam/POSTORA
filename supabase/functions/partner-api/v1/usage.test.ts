// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withPartnerAuth } from "./authenticated.ts";
import { getUsage, usagePeriodFor } from "./usage.ts";

// ---------------------------------------------------------------------------
// GET /v1/usage (10.1 / plan 2.7). The route reads ONE row — the presented
// key's — and renders the buckets the quota RPCs maintain. The period logic
// is a pure function so the calendar cases are pinned with explicit clocks;
// the route tests use a last_reset_at that is current for any wall clock, or
// one that is stale for any wall clock, never one that goes stale next month.
// ---------------------------------------------------------------------------

const KEY_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["usage:read"],
  rate_limit_per_min: 60,
  monthly_quota: 100,
  expires_at: null,
  revoked_at: null,
};

/** The first instant of the current UTC month: current for any clock. */
function currentMonthStartIso(): string {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

interface RowOverrides {
  last_reset_at?: string;
  scopes?: string[];
}

function usageStub(overrides: RowOverrides = {}) {
  const row = {
    ...KEY_ROW,
    scopes: overrides.scopes ?? KEY_ROW.scopes,
    usage_reserved: 2,
    usage_confirmed: 5,
    usage_indeterminate: 1,
    current_usage_count: 8,
    last_reset_at: overrides.last_reset_at ?? currentMonthStartIso(),
  };
  const filters: Array<[string, unknown]> = [];
  const admin = {
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve({ data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null });
      }
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_api_usage") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      return {
        select() { return this; },
        eq(col: string, val: unknown) { filters.push([col, val]); return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
      };
    },
  };
  return { admin, filters };
}

function usageRequest() {
  return new Request("https://partner.example/functions/v1/partner-api/v1/usage", {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
}

async function call(admin: unknown, requestId = "req-usage") {
  const wrapped = withPartnerAuth("get_usage", "A", getUsage, () => admin);
  const res = await wrapped(usageRequest(), requestId, {}, () => admin);
  return { res, body: await res.json() as Record<string, unknown> };
}

Deno.test("the current period renders every bucket and the charged total, in the documented shape", async () => {
  const { admin } = usageStub();
  const { res, body } = await call(admin, "req-usage-1");
  assertEquals(res.status, 200);
  assertEquals(body, {
    period: { start: currentMonthStartIso(), end: usagePeriodFor(new Date(currentMonthStartIso()), new Date()).end },
    meters: [{ meter: "messages", limit: 100, reserved: 2, confirmed: 5, indeterminate: 1, charged: 8 }],
    rate_limit: { per_minute: 60 },
    request_id: "req-usage-1",
  });
});

Deno.test("a key without usage:read is refused with insufficient_scope", async () => {
  const { admin } = usageStub({ scopes: [] });
  const { res, body } = await call(admin);
  assertEquals(res.status, 403);
  assertEquals((body.error as Record<string, unknown>).code, "insufficient_scope");
});

Deno.test("the route reads the authenticated key's row and no other", async () => {
  const { admin, filters } = usageStub();
  await call(admin);
  assertEquals(filters.filter(([col]) => col === "id").map(([, val]) => val), [KEY_ROW.id]);
});

Deno.test("a row whose period ended is rendered as the current month, empty — a read never resets it", async () => {
  // 2020-01-01 is stale for any clock this test will ever run under.
  const { admin } = usageStub({ last_reset_at: "2020-01-01T00:00:00.000Z" });
  const { body } = await call(admin);
  assertEquals((body.period as Record<string, string>).start, currentMonthStartIso());
  assertEquals(body.meters, [{ meter: "messages", limit: 100, reserved: 0, confirmed: 0, indeterminate: 0, charged: 0 }]);
});

Deno.test("usagePeriodFor: December rolls to January of the next year", () => {
  const period = usagePeriodFor(new Date("2026-12-01T00:00:00.000Z"), new Date("2026-12-15T00:00:00.000Z"));
  assertEquals(period, { start: "2026-12-01T00:00:00.000Z", end: "2027-01-01T00:00:00.000Z", stale: false });
});

Deno.test("usagePeriodFor: a reset from last month is stale on the first of this month, in UTC", () => {
  const period = usagePeriodFor(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-09-01T00:00:00.000Z"));
  assertEquals(period, { start: "2026-09-01T00:00:00.000Z", end: "2026-10-01T00:00:00.000Z", stale: true });
  // One millisecond before the month turns, it is still current.
  const stillCurrent = usagePeriodFor(new Date("2026-08-01T00:00:00.000Z"), new Date("2026-08-31T23:59:59.999Z"));
  assertEquals(stillCurrent.stale, false);
});
