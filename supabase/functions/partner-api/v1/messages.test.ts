// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { SEND_TEMPLATE_SUSPENDED } from "../router.ts";

// ---------------------------------------------------------------------------
// Phase 3 Stage 2 — POST /v1/messages and GET /v1/templates (3.5, 3.6, 3.7).
//
// The load-bearing test here is T6: EVERY send path writes a dispatch intent.
// Text sending is new provider surface, and a text path that reached Meta
// without an intent row would silently reintroduce the duplicate D13 Stage 1
// closed — a crash mid-call would let the retry send the customer a second
// real message. Asserting on the intent row rather than on the response is
// the difference between checking the safety property and checking a symptom.
// ---------------------------------------------------------------------------

const KEY_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  social_account_id: "acct-1",
  key_prefix: "pk_live_abcd",
  scopes: ["whatsapp:template.send", "whatsapp:templates.read", "messages:send"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

const ACCOUNT_ROW = {
  id: "acct-1",
  user_id: "user-1",
  workspace_id: "ws-1",
  platform: "whatsapp",
  platform_user_id: "phone-1",
  access_token: "token",
  // 'cloud_api' is a REAL value from social_accounts_connection_mode_chk
  // (20260821090000). This fixture said "cloud" for years, which that
  // constraint forbids — harmless while the route only compared against
  // 'evolution_qr', wrong the moment the 9.2 capability matrix started
  // reading the mode meaningfully.
  connection_mode: "cloud_api",
  is_active: true,
  needs_reauth: false,
  token_expires_at: null,
  account_metadata: { waba_id: "waba-1" },
};

interface StubOpts {
  keyRow?: unknown;
  account?: Record<string, unknown>;
  /** `null` data models a limiter outage (class B/C must fail closed). */
  limiter?: { data: unknown; error: unknown };
  /** Digits-only phones opted out for the sending account's owner. */
  optedOutPhones?: string[];
  /** The opt-out read itself fails. */
  optOutLookupError?: boolean;
}

function stub(opts: StubOpts = {}) {
  const intents: Record<string, unknown>[] = [];
  const rpcCalls: string[] = [];
  const { keyRow = KEY_ROW, account = ACCOUNT_ROW } = opts;
  const limiter = opts.limiter ??
    { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };

  const client = {
    intents,
    rpcCalls,
    rpc(name: string) {
      rpcCalls.push(name);
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      if (name === "claim_partner_idempotency") {
        return Promise.resolve({
          data: { outcome: "claimed", attempt_token: "tok-1" },
          error: null,
        });
      }
      if (name === "reserve_partner_quota") return Promise.resolve({ data: { allowed: true }, error: null });
      return Promise.resolve({ data: null, error: null });
    },
    from(table: string) {
      if (table === "messaging_opt_outs") {
        let userId = "";
        const chain = {
          select() { return chain; },
          in() { return chain; },
          eq(col: string, val: string) {
            if (col === "user_id") userId = val;
            return chain;
          },
          then(onFulfilled: (v: { data: unknown; error: unknown }) => unknown) {
            if (opts.optOutLookupError) {
              return Promise.resolve({ data: null, error: { message: "statement timeout" } }).then(onFulfilled);
            }
            const phones = userId === account.user_id ? (opts.optedOutPhones ?? []) : [];
            return Promise.resolve({
              data: phones.map((phone) => ({ phone })),
              error: null,
            }).then(onFulfilled);
          },
        };
        return chain;
      }
      if (table === "system_logs") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      if (table === "partner_api_idempotency") {
        const chain = {
          eq() { return chain; },
          then(onFulfilled: (v: { error: null }) => unknown) {
            return Promise.resolve({ error: null }).then(onFulfilled);
          },
        };
        return { update: () => chain };
      }
      if (table === "partner_dispatch_intents") {
        return {
          insert(row: Record<string, unknown>) {
            intents.push(row);
            return Promise.resolve({ error: null });
          },
          select() { return this; },
          eq() { return this; },
          maybeSingle() { return Promise.resolve({ data: null, error: null }); },
          update() { return { eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }; },
        };
      }
      if (table === "partner_api_usage") {
        return { insert: () => Promise.resolve({ error: null }) };
      }
      const row = table === "partner_api_keys" ? keyRow : account;
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: row, error: null }); },
        insert() { return Promise.resolve({ error: null }); },
        update() { return { eq: () => Promise.resolve({ error: null }) }; },
      };
    },
    // deno-lint-ignore no-explicit-any
  } as any;
  return client;
}

function v1(path: string, init: RequestInit = {}) {
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
    ...init,
  });
}

async function code(res: Response): Promise<string | null> {
  const body = await res.json().catch(() => ({}));
  return body?.error?.code ?? null;
}

// --- T1 --------------------------------------------------------------------

Deno.test("T1: a template send through /v1 is refused by the SAME suspension as the alias", async () => {
  // The endpoint ships behind the flag deliberately, so restoration is one
  // decision that opens both surfaces rather than leaving /v1 quietly open.
  assertEquals(SEND_TEMPLATE_SUSPENDED, true, "this test describes the suspended state");

  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      body: JSON.stringify({
        type: "template",
        recipient_phone: "+10000000000",
        template: { name: "hello" },
      }),
    }),
    () => stub(),
  );
  assertEquals(res.status, 503);
  assertEquals(await code(res), "temporarily_unavailable");
});

Deno.test("T1b: scope is checked BEFORE the suspension, so an unscoped key still learns it is unscoped", async () => {
  // A partner must be able to tell "you may never do this with this key" from
  // "nobody may do this yet": the first needs a grant, the second needs
  // waiting. Collapsing them sends someone to wait for an outage that is
  // really a missing scope.
  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ type: "template", recipient_phone: "+1", template: { name: "x" } }),
    }),
    () => stub({ keyRow: { ...KEY_ROW, scopes: [] } }),
  );
  assertEquals(await code(res), "insufficient_scope");
});

// --- T2 --------------------------------------------------------------------

Deno.test("T2: a send without Idempotency-Key is refused", async () => {
  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ type: "text", recipient_phone: "+1", text: { body: "hi" } }),
    }),
    () => stub(),
  );
  assertEquals(await code(res), "missing_idempotency_key");
});

// --- T3 --------------------------------------------------------------------

Deno.test("T3: an unmatched /v1 path still 404s WITHOUT touching Supabase", async () => {
  // Non-enumerability: a probe must learn nothing about what exists, so
  // authentication attaches to a MATCHED route and never above routing.
  let created = false;
  const res = await handleRequest(
    v1("/v1/no-such-thing", { method: "GET" }),
    () => {
      created = true;
      return stub();
    },
  );
  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
  assertEquals(created, false, "an unmatched /v1 path must not create a Supabase client");
});

// --- T5 --------------------------------------------------------------------

Deno.test("T5: an unsupported message type is a permanent unsupported_capability, not a suspension", async () => {
  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ type: "sticker", recipient_phone: "+1" }),
    }),
    () => stub(),
  );
  assertEquals(res.status, 422);
  assertEquals(await code(res), "unsupported_capability");
  const body = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      body: JSON.stringify({ type: "sticker", recipient_phone: "+1" }),
    }),
    () => stub(),
  ).then((r) => r.json());
  // Non-retryable: the same request will never become valid.
  assertEquals(body.error.retryable, false);
});

// --- T6 — the load-bearing one ---------------------------------------------

Deno.test("T6: the TEXT send path writes a dispatch intent (D13's boundary is not template-only)", async () => {
  // Before 9.2 this was pinned to an evolution_qr account so `sendText`
  // refused at its own guard before any network call. The 9.2 capability
  // matrix now refuses that cell AT THE DOOR — before the intent, which is
  // the entire point of 9.2 (see messages.capability.test.ts C1b) — so the
  // old pin would make this property unobservable. The account is a
  // sendable one instead and the provider call fails against the bogus
  // token exactly as media.test.ts R2's does: the property under test is
  // isolated exactly -- the intent is recorded before the provider is
  // approached, whatever the provider then says.
  const client = stub();
  await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-postora-key": "pk_live_test",
        "idempotency-key": "idem-text-1",
      },
      body: JSON.stringify({ type: "text", recipient_phone: "+1", text: { body: "hello" } }),
    }),
    () => client,
  );

  // Assert on the INTENT ROW, not the response: a text path that reached Meta
  // without one would answer just as happily while reintroducing the
  // duplicate D13 exists to prevent.
  assertEquals(
    client.intents.length,
    1,
    "a text send must record exactly one dispatch intent before the provider call",
  );
  assertEquals(client.intents[0].idempotency_key, "idem-text-1");
  // The summary identifies the message without carrying its body: an intent
  // row outlives key deletion, and a text body may be anything a customer typed.
  const summary = client.intents[0].request_summary as Record<string, unknown>;
  assertEquals(summary.message_type, "text");
  assertEquals("body" in summary, false, "the message body must not be stored in the intent");
});

// --- T8 --------------------------------------------------------------------

Deno.test("T9: an opted-out recipient reaches the client as recipient_opted_out and creates no intent", async () => {
  const client = stub({ optedOutPhones: ["96550000001"] });
  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-postora-key": "pk_live_test",
        "idempotency-key": "idem-opt-out",
      },
      body: JSON.stringify({
        type: "text",
        recipient_phone: "+965 5000-0001",
        text: { body: "hello" },
      }),
    }),
    () => client,
  );
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body.error.code, "recipient_opted_out");
  assertEquals(body.error.message, "This customer has opted out of WhatsApp messages");
  assertEquals(body.error.retryable, false);
  assertEquals(typeof body.error.request_id, "string");
  assertEquals(client.intents.length, 0);
  assertEquals(client.rpcCalls.includes("reserve_partner_quota"), false);
});

Deno.test("T10: an opt-out lookup failure reaches the client as a retryable 503", async () => {
  const client = stub({ optOutLookupError: true });
  const res = await handleRequest(
    v1("/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-postora-key": "pk_live_test",
        "idempotency-key": "idem-opt-out-down",
      },
      body: JSON.stringify({
        type: "text",
        recipient_phone: "+965 5000-0001",
        text: { body: "hello" },
      }),
    }),
    () => client,
  );
  assertEquals(res.status, 503);
  const body = await res.json();
  assertEquals(body.error.code, "opt_out_lookup_failed");
  assertEquals(body.error.retryable, true);
  assertEquals(client.intents.length, 0);
  assertEquals(client.rpcCalls.includes("reserve_partner_quota"), false);
});

Deno.test("T8: GET /v1/templates fails CLOSED on a limiter outage (D7 class B)", async () => {
  const res = await handleRequest(
    v1("/v1/templates", { method: "GET" }),
    () => stub({ limiter: { data: null, error: { message: "boom" } } }),
  );
  assertEquals(res.status, 503);
  assertEquals(await code(res), "limiter_unavailable");
  const body = await res.json().catch(() => ({}));
  // Distinguishable from the 0A suspension, which is also 503 but retryable:false.
  assertEquals(body?.error?.retryable ?? true, true);
});
