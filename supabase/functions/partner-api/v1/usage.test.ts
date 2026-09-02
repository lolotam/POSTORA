// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { withPartnerAuth } from "./authenticated.ts";
import { getUsage } from "./usage.ts";

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

function makeUsageClient(overrides: {
  monthly_quota?: number | null;
  rate_limit_per_min?: number;
  usage_reserved?: number;
  usage_confirmed?: number;
  usage_indeterminate?: number;
  current_usage_count?: number;
  last_reset_at?: string;
  eqCapture?: { id: string | null };
} = {}) {
  const row = {
    id: KEY_ROW.id,
    workspace_id: KEY_ROW.workspace_id,
    social_account_id: KEY_ROW.social_account_id,
    key_prefix: KEY_ROW.key_prefix,
    scopes: KEY_ROW.scopes,
    expires_at: KEY_ROW.expires_at,
    revoked_at: KEY_ROW.revoked_at,
    monthly_quota: overrides.monthly_quota !== undefined ? overrides.monthly_quota : 100,
    rate_limit_per_min: overrides.rate_limit_per_min ?? 60,
    usage_reserved: overrides.usage_reserved ?? 2,
    usage_confirmed: overrides.usage_confirmed ?? 5,
    usage_indeterminate: overrides.usage_indeterminate ?? 1,
    current_usage_count: overrides.current_usage_count ?? 8,
    last_reset_at: overrides.last_reset_at ?? "2026-09-01T00:00:00.000Z",
  };
  const limiter = { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };
  const inserts: unknown[] = [];
  const admin = {
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_api_usage") {
        return { insert(row: unknown) { inserts.push(row); return Promise.resolve({ error: null }); } };
      }
      if (table === "partner_api_keys") {
        return {
          select() { return this; },
          eq(col: string, val: unknown) {
            if (col === "id" && overrides.eqCapture) overrides.eqCapture.id = String(val);
            return this;
          },
          maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        };
      }
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  } as unknown as never;
  return { admin, row, inserts };
}

Deno.test("usage happy path returns the documented shape with meters and rate_limit", async () => {
  const { admin } = makeUsageClient();
  const wrapped = withPartnerAuth("get_usage", "A", getUsage, () => admin);
  const req = new Request("https://partner.example/functions/v1/partner-api/v1/usage", {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
  const res = await wrapped(req, "req-usage-1", {}, () => admin);
  assertEquals(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  const period = body.period as Record<string, string>;
  assertEquals(typeof period.start, "string");
  assertEquals(typeof period.end, "string");
  const meters = body.meters as Array<Record<string, unknown>>;
  assertEquals(meters.length, 1);
  assertEquals(meters[0].meter, "messages");
  assertEquals(meters[0].limit, 100);
  assertEquals(meters[0].reserved, 2);
  assertEquals(meters[0].confirmed, 5);
  assertEquals(meters[0].indeterminate, 1);
  assertEquals(meters[0].charged, 8);
  const rate = body.rate_limit as Record<string, unknown>;
  assertEquals(rate.per_minute, 60);
  assertEquals(body.request_id, "req-usage-1");
});

Deno.test("usage without the scope is refused with insufficient_scope", async () => {
  const keyNoScope = { ...KEY_ROW, scopes: [] as string[] };
  const limiter = { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };
  const admin = {
    rpc(name: string) { if (name === "consume_partner_rate_v2") return Promise.resolve(limiter); return Promise.resolve({ error: null }); },
    from(table: string) {
      if (table === "partner_api_usage") return { insert: () => Promise.resolve({ error: null }) } as never;
      const row = table === "partner_api_keys" ? keyNoScope : null;
      return { select() { return this; }, eq() { return this; }, maybeSingle() { return Promise.resolve({ data: row, error: null }); } } as never;
    },
  } as unknown as never;
  const wrapped = withPartnerAuth("get_usage", "A", getUsage, () => admin);
  const req = new Request("https://partner.example/functions/v1/partner-api/v1/usage", {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
  const res = await wrapped(req, "req-usage-2", {}, () => admin);
  assertEquals(res.status, 403);
  const body = await res.json() as Record<string, unknown>;
  const err = (body as { error: Record<string, unknown> }).error;
  assertEquals(err.code, "insufficient_scope");
});

Deno.test("usage period.end for December rolls to January of the next year", async () => {
  const { admin } = makeUsageClient({ last_reset_at: "2026-12-01T00:00:00.000Z" });
  const wrapped = withPartnerAuth("get_usage", "A", getUsage, () => admin);
  const req = new Request("https://partner.example/functions/v1/partner-api/v1/usage", {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
  const res = await wrapped(req, "req-usage-3", {}, () => admin);
  assertEquals(res.status, 200);
  const body = await res.json() as Record<string, unknown>;
  const period = body.period as Record<string, string>;
  assertEquals(period.end, "2027-01-01T00:00:00.000Z");
});

Deno.test("usage route reads partner_api_keys by the authenticated key id", async () => {
  const capture: { id: string | null } = { id: null };
  const { admin } = makeUsageClient({ eqCapture: capture });
  const wrapped = withPartnerAuth("get_usage", "A", getUsage, () => admin);
  const req = new Request("https://partner.example/functions/v1/partner-api/v1/usage", {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
  });
  const res = await wrapped(req, "req-usage-4", {}, () => admin);
  assertEquals(res.status, 200);
  assertEquals(capture.id, KEY_ROW.id);
});
