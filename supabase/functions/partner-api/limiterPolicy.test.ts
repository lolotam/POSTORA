// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
// index.ts binds its port via Deno.serve only when run as the main module, so
// this import stays side-effect free and the tests below exercise the real
// production handler — the only stub is the Supabase client boundary.
import { handleRequest } from "./index.ts";

const KEY_ROW = {
  id: "key-1", workspace_id: "ws-1", social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send", "whatsapp:templates.read"],
  rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
};

const ACCOUNT_ROW = {
  id: "acct-1", user_id: "user-1", workspace_id: "ws-1", platform: "whatsapp",
  platform_user_id: "phone-1", access_token: "token", connection_mode: "cloud",
  is_active: true, needs_reauth: false, token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

/** Stub of the Supabase client boundary: routes by RPC name and by table.
 *  `limiter` is the consume_partner_rate result — the one result these tests
 *  vary; everything else serves the minimum the handler needs. */
function stubClient(limiter: { data: unknown; error: { message: string } | null }, keyRow: unknown = KEY_ROW) {
  return {
    rpc(name: string) {
      if (name === "consume_partner_rate") return Promise.resolve(limiter);
      // touch_partner_key / release_partner_quota: bookkeeping, error-free.
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      if (table === "partner_api_usage") {
        return { insert() { return Promise.resolve({ error: null }); } };
      }
      const row = table === "partner_api_keys" ? keyRow : ACCOUNT_ROW;
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
      };
    },
  // deno-lint-ignore no-explicit-any
  } as any;
}

function partnerRequest(action: string) {
  return new Request("https://partner.example/functions/v1/partner-api", {
    method: "POST",
    headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
    body: JSON.stringify({ action }),
  });
}

const RATE_HEADERS = ["x-ratelimit-limit", "x-ratelimit-remaining", "x-ratelimit-reset"];
const noRateHeaders = (res: Response) => RATE_HEADERS.map((h) => res.headers.get(h));

const LIMITER_DOWN = { data: null, error: { message: "connection refused" } };
const LIMITER_OK = { data: true, error: null };

Deno.test("class A (get_status) proceeds when the limiter RPC errors", async () => {
  const res = await handleRequest(partnerRequest("get_status"), () => stubClient(LIMITER_DOWN));
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.whatsapp_connected, true);
  assertEquals(body.phone_number_id, "phone-1");
  // Fail-open does not mean budget-resolved: no X-RateLimit-* headers may
  // appear, because the limiter never answered for this key.
  assertEquals(noRateHeaders(res), [null, null, null]);
});

Deno.test("class B (list_templates) fails closed: 503 limiter_unavailable + Retry-After", async () => {
  const res = await handleRequest(partnerRequest("list_templates"), () => stubClient(LIMITER_DOWN));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, "limiter_unavailable");
  assertEquals(body.error.retryable, true);
  assertEquals(res.headers.get("retry-after"), "5");
  // No budget was resolved, so all three rate headers are omitted.
  assertEquals(noRateHeaders(res), [null, null, null]);
});

Deno.test("class C (send_template) fails closed: 503 limiter_unavailable + Retry-After", async () => {
  // No Idempotency-Key needed: the limiter verdict fires before the
  // idempotency checks, so the 503 is reachable exactly as a partner retry
  // loop during an outage would see it.
  const res = await handleRequest(partnerRequest("send_template"), () => stubClient(LIMITER_DOWN));
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, "limiter_unavailable");
  assertEquals(body.error.retryable, true);
  assertEquals(res.headers.get("retry-after"), "5");
  assertEquals(noRateHeaders(res), [null, null, null]);
});

Deno.test("a pre-auth 401 omits all X-RateLimit-* headers", async () => {
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient(LIMITER_OK, null), // key lookup finds nothing
  );
  assertEquals(res.status, 401);
  assertEquals((await res.json()).error.code, "invalid_key");
  // There is no key whose budget could be reported; fabricating one would
  // leak whether a key exists.
  assertEquals(noRateHeaders(res), [null, null, null]);
  assertEquals(res.headers.get("retry-after"), null);
});

Deno.test("CORS preflight omits all X-RateLimit-* headers and touches no database", async () => {
  const res = await handleRequest(
    new Request("https://partner.example/functions/v1/partner-api", { method: "OPTIONS" }),
    () => {
      throw new Error("preflight must not construct a database client");
    },
  );
  assertEquals(res.status, 200);
  assertEquals(noRateHeaders(res), [null, null, null]);
});

Deno.test("a limiter-consumed success carries Limit and Reset; Remaining is omitted", async () => {
  const res = await handleRequest(partnerRequest("get_status"), () => stubClient(LIMITER_OK));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-ratelimit-limit"), "60");
  // consume_partner_rate returns only a boolean — no remaining count is
  // derivable on the passing path, so none may be invented.
  assertEquals(res.headers.get("x-ratelimit-remaining"), null);
  const reset = Number(res.headers.get("x-ratelimit-reset"));
  // The bucket is keyed on date_trunc('minute'), so the reset is always
  // 1..60 seconds out.
  assertEquals(reset >= 1 && reset <= 60, true);
});

Deno.test("a 429 rate_limited carries Limit, Remaining 0 and Reset — the limiter worked", async () => {
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient({ data: false, error: null }),
  );
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error.code, "rate_limited");
  assertEquals(body.error.retryable, true);
  assertEquals(res.headers.get("x-ratelimit-limit"), "60");
  // The refusal proves the count is over the limit: 0 is exact, not invented.
  assertEquals(res.headers.get("x-ratelimit-remaining"), "0");
  assertEquals(Number(res.headers.get("x-ratelimit-reset")) >= 1, true);
});
