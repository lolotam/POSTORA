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
 *  `limiter` is the consume_partner_rate_v2 result — the one result these
 *  tests vary; everything else serves the minimum the handler needs.
 *  `tableReads` records every table the handler touched, so a test can prove
 *  a refused request never got as far as reading the account — the step
 *  immediately before a provider call. */
function stubClient(limiter: { data: unknown; error: { message: string } | null }, keyRow: unknown = KEY_ROW) {
  const tableReads: string[] = [];
  return {
    tableReads,
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      // touch_partner_key / release_partner_quota: bookkeeping, error-free.
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      tableReads.push(table);
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
const LIMITER_OK = { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };

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

Deno.test("a limiter-consumed success publishes the exact budget the RPC reported", async () => {
  const res = await handleRequest(partnerRequest("get_status"), () => stubClient(LIMITER_OK));
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-ratelimit-limit"), "60");
  // Exact equality with the RPC values, not a range: 42 is a number no local
  // clock computation can produce on demand, so if any code on the path
  // recomputes Remaining or Reset instead of passing the database's numbers
  // through, this fails. That is the regression the old "between 1 and 60"
  // assertion could never catch.
  assertEquals(res.headers.get("x-ratelimit-remaining"), "59");
  assertEquals(res.headers.get("x-ratelimit-reset"), "42");
});

Deno.test("the last allowed request of a dying window reports Remaining 0 and Reset 1", async () => {
  // The bucket's final slot consumed at second 59.9 of the minute: remaining
  // 0 is exact (this was the last one), and reset is 1 — never 0, because the
  // window that was consumed is not over yet, and never 60, which only a
  // clock other than the bucket's own would claim here.
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient({ data: { allowed: true, remaining: 0, reset_seconds: 1 }, error: null }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-ratelimit-limit"), "60");
  assertEquals(res.headers.get("x-ratelimit-remaining"), "0");
  assertEquals(res.headers.get("x-ratelimit-reset"), "1");
});

Deno.test("a request consumed at second zero of a fresh window reports Reset 60", async () => {
  // 60 at second zero is CORRECT when the number comes from the clock that
  // picked the bucket: that window genuinely ends 60 seconds away. The old
  // locally-computed value could also emit 60 here — but about the OTHER
  // bucket whenever the two clocks disagreed. Exact equality pins the number
  // to the database's own.
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient({ data: { allowed: true, remaining: 57, reset_seconds: 60 }, error: null }),
  );
  assertEquals(res.status, 200);
  assertEquals(res.headers.get("x-ratelimit-reset"), "60");
});

Deno.test("a 429 rate_limited carries Limit, Remaining, Reset AND Retry-After — all real", async () => {
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient({ data: { allowed: false, remaining: 0, reset_seconds: 37 }, error: null }),
  );
  assertEquals(res.status, 429);
  const body = await res.json();
  assertEquals(body.error.code, "rate_limited");
  assertEquals(body.error.retryable, true);
  assertEquals(res.headers.get("x-ratelimit-limit"), "60");
  // The refusal proves the count is over the limit: 0 is exact, not invented.
  assertEquals(res.headers.get("x-ratelimit-remaining"), "0");
  assertEquals(res.headers.get("x-ratelimit-reset"), "37");
  // Retry-After is the same database-derived number — the delay in seconds
  // until the window that refused this call ends — not a second clock
  // reading. Ceil on the database side guarantees a retry at or after the
  // window's end.
  assertEquals(res.headers.get("retry-after"), "37");
});

Deno.test("a malformed limiter result (data null) fails CLOSED for class C and never reaches the account", async () => {
  const client = stubClient({ data: null, error: null });
  const res = await handleRequest(partnerRequest("send_template"), () => client);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, "limiter_unavailable");
  assertEquals(res.headers.get("retry-after"), "5");
  assertEquals(noRateHeaders(res), [null, null, null]);
  // The account lookup is the last step before a provider call. It never
  // happened, so no provider call could have either — and the ledger row for
  // the refused request was still written (record is set by then).
  assertEquals(client.tableReads.includes("social_accounts"), false);
  assertEquals(client.tableReads.includes("partner_api_usage"), true);
});

Deno.test("a malformed limiter result (unexpected object) fails CLOSED for class C and never reaches the account", async () => {
  // Not a literal boolean `allowed`: a truthy string is exactly the kind of
  // drifted-RPC value that must not sail through as "the limiter allowed it".
  const client = stubClient({
    data: { allowed: "yes", remaining: 59, reset_seconds: 42 },
    error: null,
  });
  const res = await handleRequest(partnerRequest("send_template"), () => client);
  assertEquals(res.status, 503);
  assertEquals((await res.json()).error.code, "limiter_unavailable");
  assertEquals(noRateHeaders(res), [null, null, null]);
  assertEquals(client.tableReads.includes("social_accounts"), false);
});

Deno.test("a v1-shaped boolean limiter result is not a budget: class A proceeds, without headers", async () => {
  // If the deployed edge code ever runs against the old consume_partner_rate
  // shape (a deployment-ordering mistake, or a drifted RPC), the boolean
  // carries no numbers, so nothing may be published — and the request must
  // not be treated as limiter-resolved for a class B/C action either
  // (covered in partnerApiMetering.test.ts).
  const res = await handleRequest(
    partnerRequest("get_status"),
    () => stubClient({ data: true, error: null }),
  );
  assertEquals(res.status, 200);
  assertEquals(noRateHeaders(res), [null, null, null]);
});
