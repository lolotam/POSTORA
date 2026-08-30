// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
// index.ts binds its port via Deno.serve only when run as the main module, so
// this import stays side-effect free and the tests below exercise the real
// production handler — the only stub is the Supabase client boundary.
import { handleRequest } from "./index.ts";
import { isActionSuspended, SEND_TEMPLATE_SUSPENDED } from "./router.ts";

// The 0A safety suspension: send_template must be refused with a typed,
// retryable-false error, before it consumes any budget or poisons any
// idempotency key, while get_status / list_templates and the scope check keep
// behaving exactly as before.

const KEY_ROW_FULL = {
  id: "key-1", workspace_id: "ws-1", social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send", "whatsapp:templates.read"],
  rate_limit_per_min: 60, monthly_quota: null, expires_at: null, revoked_at: null,
};

const KEY_ROW_NO_SEND = {
  ...KEY_ROW_FULL,
  id: "key-2",
  scopes: ["whatsapp:templates.read"],
};

const ACCOUNT_ROW = {
  id: "acct-1", user_id: "user-1", workspace_id: "ws-1", platform: "whatsapp",
  platform_user_id: "phone-1", access_token: "token", connection_mode: "cloud",
  is_active: true, needs_reauth: false, token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

/** Stub of the Supabase client boundary. Records every RPC invoked (by name)
 *  and every table touched, so a test can prove the suspension refusal fires
 *  before the limiter, the account lookup, the idempotency claim and the quota
 *  reservation — and that the usage ledger still recorded the refusal. */
function stubClient(keyRow: unknown = KEY_ROW_FULL) {
  const rpcCalls: string[] = [];
  const tableReads: string[] = [];
  const usageInserts: Record<string, unknown>[] = [];
  return {
    rpcCalls,
    tableReads,
    usageInserts,
    rpc(name: string) {
      rpcCalls.push(name);
      // A resolved budget in the exact shape consume_partner_rate_v2
      // produces, so class-B actions (list_templates) pass the limiter
      // cleanly — these tests vary the suspension, not the limiter.
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve(
          { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null },
        );
      }
      return Promise.resolve({ error: null });
    },
    from(table: string) {
      tableReads.push(table);
      if (table === "partner_api_usage") {
        return {
          insert(row: Record<string, unknown>) {
            usageInserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
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

function partnerRequest(action: string, keyRow: unknown = KEY_ROW_FULL) {
  return {
    request: new Request("https://partner.example/functions/v1/partner-api", {
      method: "POST",
      headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
      body: JSON.stringify({ action }),
    }),
    client: stubClient(keyRow),
  };
}

Deno.test("send_template is refused with a typed, retryable-false temporarily_unavailable error", async () => {
  const { request, client } = partnerRequest("send_template");
  const res = await handleRequest(request, () => client);
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.success, false);
  assertEquals(body.error.code, "temporarily_unavailable");
  // The flag, not the status family, is the retry contract: 503 usually
  // invites retries, so retryable:false is what a partner's retry logic must
  // obey here.
  assertEquals(body.error.retryable, false);
  // Correlatable like every other response.
  assertEquals(typeof body.request_id, "string");
  // No schedule may be promised: restoration is gated on an engineering
  // milestone, not a duration.
  assertEquals(res.headers.get("retry-after"), null);
});

Deno.test("the suspension refusal happens before the limiter, the account lookup, the idempotency claim and the quota reservation", async () => {
  const { request, client } = partnerRequest("send_template");
  const res = await handleRequest(request, () => client);
  assertEquals(res.status, 503);

  // No RPC at all: neither the rate limiter (consume_partner_rate_v2) nor a
  // quota reservation (reserve_partner_quota) may run for an action that can
  // never succeed — a suspended send consumes no budget of any kind.
  assertEquals(client.rpcCalls, []);
  // The account lookup is the last step before provider work; it must not
  // happen, so no provider call could have either.
  assertEquals(client.tableReads.includes("social_accounts"), false);
  // No idempotency table operation: the refusal must not claim, settle or
  // poison an Idempotency-Key.
  assertEquals(client.tableReads.includes("partner_api_idempotency"), false);
  // The refusal IS still a request the partner made: the ledger records it,
  // non-billable, under the typed error code.
  assertEquals(client.usageInserts.length, 1);
  assertEquals(client.usageInserts[0].billable, false);
  assertEquals(client.usageInserts[0].error_code, "temporarily_unavailable");
  assertEquals(client.usageInserts[0].action, "send_template");
});

Deno.test("the suspension does not bypass authorization: a key lacking the send scope still gets insufficient_scope", async () => {
  const { request, client } = partnerRequest("send_template", KEY_ROW_NO_SEND);
  const res = await handleRequest(request, () => client);
  assertEquals(res.status, 403);
  const body = await res.json();
  // The scope verdict, NOT the suspension error: a partner must be able to
  // tell "you may never do this with this key" from "nobody may do this yet".
  assertEquals(body.error.code, "insufficient_scope");
  assertEquals(body.error.retryable, false);
});

Deno.test("get_status is unaffected by the suspension", async () => {
  const { request, client } = partnerRequest("get_status");
  const res = await handleRequest(request, () => client);
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.success, true);
  assertEquals(body.whatsapp_connected, true);
  assertEquals(body.phone_number_id, "phone-1");
  assertEquals(body.workspace_id, "ws-1");
});

Deno.test("list_templates is unaffected by the suspension", async () => {
  const { request, client } = partnerRequest("list_templates");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          data: [{
            name: "invoice_due_v1", language: "ar", status: "APPROVED",
            category: "UTILITY", components: [],
          }],
        }),
        { status: 200 },
      ),
    )) as typeof fetch;
  try {
    const res = await handleRequest(request, () => client);
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.success, true);
    assertEquals(body.templates.length, 1);
    assertEquals(body.templates[0].name, "invoice_due_v1");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

Deno.test("the router keeps send_template a known action while it is suspended", async () => {
  // isActionSuspended must consult the switch, not hardcode a verdict, so
  // restoring really is flipping one value.
  assertEquals(isActionSuspended("send_template"), SEND_TEMPLATE_SUSPENDED);
  // The suspension never extends to other actions, known or not.
  assertEquals(isActionSuspended("get_status"), false);
  assertEquals(isActionSuspended("list_templates"), false);
  assertEquals(isActionSuspended("drop_database"), false);
});
