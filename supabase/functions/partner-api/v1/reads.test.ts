// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { decodeCursor, encodeCursor, keysetFilter } from "./pagination.ts";
import { decodeId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Phase 2 read surface — deliverables 2.3-2.6.
//
// The load-bearing test here is T1. Every other test would still pass if the
// reads anchored on `partner_api_keys.social_account_id` — the alias's primary
// account — instead of on the D4 binding table, because in production those
// two values are the same. T1 is the one that separates them, and a read
// surface that fails it answers about the wrong account while looking
// perfectly healthy.
//
// The stub records the FILTERS each query carried rather than simulating
// PostgREST. That is the deliberate boundary: what these routes get wrong is
// which rows they ask for, not what Postgres does with a correct request.
// It also means these tests cannot catch a malformed PostgREST filter STRING
// (see T12, which pins the one string that matters, and the live page-2 probe
// recorded in the PR).
// ---------------------------------------------------------------------------

const ACCT_BOUND = "22222222-2222-4222-8222-222222222222";
const ACCT_PRIMARY_ONLY = "11111111-1111-4111-8111-111111111111";
const CONV = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";

const KEY_ROW = {
  id: "key-1",
  workspace_id: "ws-1",
  // The alias's primary account. Deliberately NOT the bound one: see T1.
  social_account_id: ACCT_PRIMARY_ONLY,
  key_prefix: "pk_live_abcd",
  scopes: ["accounts:read", "conversations:read", "messages:read"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

interface Query {
  table: string;
  /** Every filter/ordering call, as [method, ...args]. */
  calls: Array<[string, ...unknown[]]>;
  or: string[];
}

interface StubOpts {
  keyRow?: unknown;
  /** Bindings in partner_api_key_accounts. Defaults to the bound account. */
  bindings?: string[];
  rows?: Record<string, unknown[]>;
  limiter?: { data: unknown; error: unknown };
}

function stub(opts: StubOpts = {}) {
  const queries: Query[] = [];
  const { keyRow = KEY_ROW, bindings = [ACCT_BOUND] } = opts;
  const limiter = opts.limiter ??
    { data: { allowed: true, remaining: 59, reset_seconds: 42 }, error: null };

  const rows: Record<string, unknown[]> = {
    partner_api_keys: [keyRow],
    partner_api_key_accounts: bindings.map((id) => ({ social_account_id: id })),
    social_accounts: [{
      id: ACCT_BOUND,
      platform: "whatsapp",
      platform_user_id: "phone-1",
      platform_username: "postora",
      is_active: true,
      needs_reauth: false,
      connected_at: "2026-08-01T00:00:00Z",
      // resolveWhatsAppAccount fields, for the shared preflight.
      user_id: "user-1",
      workspace_id: "ws-1",
      access_token: "token",
      connection_mode: "cloud",
      account_metadata: { waba_id: "waba-1" },
    }],
    ...(opts.rows ?? {}),
  };

  function builder(table: string) {
    const record: Query = { table, calls: [], or: [] };
    queries.push(record);
    const data = () => rows[table] ?? [];
    const self: any = {
      select: (...a: unknown[]) => (record.calls.push(["select", ...a]), self),
      eq: (...a: unknown[]) => (record.calls.push(["eq", ...a]), self),
      in: (...a: unknown[]) => (record.calls.push(["in", ...a]), self),
      not: (...a: unknown[]) => (record.calls.push(["not", ...a]), self),
      order: (...a: unknown[]) => (record.calls.push(["order", ...a]), self),
      limit: (...a: unknown[]) => (record.calls.push(["limit", ...a]), self),
      or: (filter: string) => (record.or.push(filter), self),
      maybeSingle: () => Promise.resolve({ data: data()[0] ?? null, error: null }),
      insert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      // Awaiting the builder is how supabase-js runs a multi-row query.
      then: (resolve: (v: unknown) => unknown) => resolve({ data: data(), error: null }),
    };
    return self;
  }

  return {
    queries,
    rpc(name: string) {
      if (name === "consume_partner_rate_v2") return Promise.resolve(limiter);
      return Promise.resolve({ data: null, error: null });
    },
    from: builder,
  } as any;
}

function v1(path: string, init: RequestInit = {}) {
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    method: "GET",
    headers: { "x-postora-key": "pk_live_test" },
    ...init,
  });
}

async function body(res: Response): Promise<any> {
  return await res.json().catch(() => ({}));
}

function queryFor(client: any, table: string): Query | undefined {
  return client.queries.find((q: Query) => q.table === table);
}

function filterArgs(query: Query, method: string, column: string): unknown[] | undefined {
  return query.calls.find((c) => c[0] === method && c[1] === column)?.slice(2);
}

// --- T1 — the load-bearing one ---------------------------------------------

Deno.test("T1: reads anchor on the D4 binding, NOT on the alias's primary account", async () => {
  // The key's `social_account_id` is ACCT_PRIMARY_ONLY and its only binding is
  // ACCT_BOUND. In production those are the same value, so every other test in
  // this file would pass against a read surface that used the wrong one. Here
  // they differ, and the tenancy filter must carry the BOUND id.
  const client = stub();
  await handleRequest(v1("/v1/conversations"), () => client);

  const conversations = queryFor(client, "messaging_cache");
  assert(conversations, "the listing must query messaging_cache");
  assertEquals(
    filterArgs(conversations, "in", "social_account_id"),
    [[ACCT_BOUND]],
    "the account filter must come from partner_api_key_accounts",
  );

  const bindingLookup = queryFor(client, "partner_api_key_accounts");
  assert(bindingLookup, "the binding table must be consulted at all");
  assertEquals(filterArgs(bindingLookup, "eq", "key_id"), ["key-1"]);
  // Tenancy proven twice: the composite FKs make a cross-workspace binding
  // unrepresentable, and the query still says so.
  assertEquals(filterArgs(bindingLookup, "eq", "workspace_id"), ["ws-1"]);
});

Deno.test("T1b: an UNBOUND key reads nothing — no fallback to the primary account", async () => {
  // A key whose bindings were revoked must lose access. Falling back to
  // partner_api_keys.social_account_id would silently restore it, and the
  // response would look identical to a working one.
  const client = stub({ bindings: [] });
  const res = await handleRequest(v1("/v1/conversations"), () => client);

  assertEquals(res.status, 200);
  assertEquals((await body(res)).data, []);
  assertEquals(
    queryFor(client, "messaging_cache"),
    undefined,
    "an unbound key must not reach the conversation table at all",
  );
});

// --- T2 — D11 account selection ---------------------------------------------

Deno.test("T2: ?account_id= naming an unbound account is resource_not_found, not forbidden", async () => {
  // D11's resource rule and the key-auth precedent: a distinct "forbidden"
  // answer would confirm the account exists, letting a stolen key enumerate a
  // workspace it cannot read.
  const res = await handleRequest(
    v1(`/v1/conversations?account_id=acc_${ACCT_PRIMARY_ONLY}`),
    () => stub(),
  );
  assertEquals(res.status, 404);
  assertEquals((await body(res)).error.code, "resource_not_found");
});

Deno.test("T2b: ?account_id= naming a bound account narrows the filter to it", async () => {
  const client = stub({ bindings: [ACCT_BOUND, ACCT_PRIMARY_ONLY] });
  await handleRequest(v1(`/v1/conversations?account_id=acc_${ACCT_BOUND}`), () => client);
  assertEquals(
    filterArgs(queryFor(client, "messaging_cache")!, "in", "social_account_id"),
    [[ACCT_BOUND]],
  );
});

// --- T3 — malformed ids must not reach the database -------------------------

Deno.test("T3: a malformed resource id 404s WITHOUT querying the table", async () => {
  // Two failures in one if this regresses. A non-UUID compared against a uuid
  // column makes PostgREST raise, so a client typo would read as a Postora
  // 500 — and that different failure is an existence ORACLE, telling a prober
  // which guesses had the right shape.
  for (const path of [`/v1/accounts/acc_nope`, `/v1/conversations/conv_123`, `/v1/messages/msg_x`]) {
    const client = stub();
    const res = await handleRequest(v1(path), () => client);
    assertEquals(res.status, 404, path);
    assertEquals((await body(res)).error.code, "resource_not_found", path);
    assertEquals(
      queryFor(client, "messaging_cache") ?? queryFor(client, "whatsapp_messages"),
      undefined,
      `${path} must not reach a resource table`,
    );
  }
});

Deno.test("T4: a well-formed id of the WRONG prefix is also resource_not_found", async () => {
  // Nothing stops two tables from sharing a UUID, so the prefix is the check
  // that keeps a conv_ from resolving as an acc_.
  const res = await handleRequest(v1(`/v1/accounts/msg_${ACCT_BOUND}`), () => stub());
  assertEquals(res.status, 404);
  assertEquals((await body(res)).error.code, "resource_not_found");
});

// --- T5/T6/T7 — pagination (2.6) --------------------------------------------

Deno.test("T5: next_cursor is emitted only when an extra row proves another page", async () => {
  const page = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `${i}0000000-0000-4000-8000-000000000000`,
      social_account_id: ACCT_BOUND,
      platform: "whatsapp",
      participant_name: "+1555",
      last_message_preview: "hi",
      last_message_at: `2026-08-0${i + 1}T00:00:00Z`,
      unread_count: 0,
    }));

  // Exactly `limit` rows: the listing is exhausted, so a cursor here would
  // make a partner's sync loop poll a feed that had ended.
  const exhausted = await handleRequest(
    v1("/v1/conversations?limit=3"),
    () => stub({ rows: { messaging_cache: page(3) } }),
  );
  assertEquals((await body(exhausted)).next_cursor, null);

  // limit + 1 rows: the extra one is the proof, and must not be returned.
  const more = await handleRequest(
    v1("/v1/conversations?limit=3"),
    () => stub({ rows: { messaging_cache: page(4) } }),
  );
  const got = await body(more);
  assertEquals(got.data.length, 3);
  assert(got.next_cursor !== null, "an extra row must produce a cursor");
  assertEquals(decodeCursor(got.next_cursor)!.timestamp, "2026-08-03T00:00:00Z");
});

Deno.test("T6: a tampered cursor is REJECTED, never silently reset to page 1", async () => {
  // A cursor that quietly restarts the listing looks to a partner's sync job
  // like "the feed ended and began again" — it will reprocess every row it
  // already handled.
  for (const bad of ["not-base64!!", btoa('{"t":"nope","i":"x"}'), btoa('{"t":"2026-08-01T00:00:00Z"}')]) {
    const res = await handleRequest(v1(`/v1/conversations?cursor=${encodeURIComponent(bad)}`), () => stub());
    assertEquals(res.status, 400, bad);
    assertEquals((await body(res)).error.code, "invalid_request", bad);
  }
});

Deno.test("T6b: a cursor timestamp that Date.parse ACCEPTS but PostgREST would choke on is refused", async () => {
  // Date.parse is not a guard: V8 still honours legacy US formats, so
  // Date.parse("May 8, 2026") succeeds. That string carries a comma, and a
  // comma separates disjuncts in PostgREST's `or=` grammar — it would split
  // the keyset filter into extra terms and answer a partner-triggerable 500
  // instead of a 400. The shape check, not the parse, is what stops it.
  const smuggled = btoa(JSON.stringify({ t: "May 8, 2026", i: CONV }));
  assertEquals(Number.isNaN(Date.parse("May 8, 2026")), false, "the premise: Date.parse accepts it");

  const client = stub();
  const res = await handleRequest(
    v1(`/v1/conversations?cursor=${encodeURIComponent(smuggled)}`),
    () => client,
  );
  assertEquals(res.status, 400);
  assertEquals((await body(res)).error.code, "invalid_request");
  assertEquals(
    queryFor(client, "messaging_cache"),
    undefined,
    "a rejected cursor must not reach the database at all",
  );
});

Deno.test("T7: limit is clamped in range but a non-integer is refused", async () => {
  const clamped = stub();
  await handleRequest(v1("/v1/conversations?limit=5000"), () => clamped);
  // limit + 1: the over-fetch that proves a next page exists.
  assertEquals(filterArgs(queryFor(clamped, "messaging_cache")!, "limit", 101), []);

  // Clamping "abc" to the default would answer a page the partner never asked
  // for, with no way to discover the typo.
  const res = await handleRequest(v1("/v1/conversations?limit=abc"), () => stub());
  assertEquals(res.status, 400);
  assertEquals((await body(res)).error.code, "invalid_request");
});

// --- T8 — D7 class A is the OPPOSITE direction from class B -----------------

Deno.test("T8: a class-A read PROCEEDS through a limiter outage", async () => {
  // The mirror of messages.test.ts T8, and the reason both exist: class B
  // fails closed because an unbounded outbound call during a database
  // incident turns one outage into two, while a bounded local read that
  // reaches no customer should not become collateral damage. A test that only
  // pinned the fail-closed half would let the asymmetry collapse in the safe-
  // looking direction.
  const res = await handleRequest(
    v1("/v1/accounts"),
    () => stub({ limiter: { data: null, error: { message: "boom" } } }),
  );
  assertEquals(res.status, 200);
  assertEquals(
    res.headers.get("X-RateLimit-Remaining"),
    null,
    "a request that resolved no budget must not report an invented one",
  );
});

// --- T9 — the alias regression this deliverable made reachable --------------

Deno.test("T9: a /v1 read action is NOT an alias action", async () => {
  // Before ALIAS_ACTIONS, index.ts read "present in ACTION_SCOPES" as "is an
  // alias action" and dispatched through an if-ladder with no final else, so
  // an unhandled-but-known action fell through to the send path — past the 0A
  // suspension and past the Idempotency-Key requirement, both of which match
  // the literal name `send_template`. Adding the six read policies is exactly
  // what would have opened it.
  const res = await handleRequest(
    new Request("https://partner.example/functions/v1/partner-api", {
      method: "POST",
      headers: { "content-type": "application/json", "x-postora-key": "pk_live_test" },
      body: JSON.stringify({
        action: "list_conversations",
        recipient_phone: "+10000000000",
        template_name: "hello",
      }),
    }),
    () => stub(),
  );
  assertEquals(res.status, 400);
  assertEquals((await body(res)).error.code, "unknown_action");
});

// --- T10 — the platform seam, stated rather than implied --------------------

Deno.test("T10: a bound non-WhatsApp conversation is unsupported_capability, not an empty page", async () => {
  // messaging_cache is cross-platform; Meta DMs live in social_inbox_events
  // with a different shape. An empty /messages page is a lie a partner cannot
  // tell from a quiet inbox. resource_not_found would be a different lie —
  // the account IS in their binding and GET /v1/accounts lists it.
  const client = stub({
    rows: {
      messaging_cache: [{
        id: CONV,
        social_account_id: ACCT_BOUND,
        platform: "facebook",
        participant_name: "Someone",
        last_message_preview: "hi",
        last_message_at: "2026-08-01T00:00:00Z",
        unread_count: 0,
      }],
    },
  });
  const res = await handleRequest(v1(`/v1/conversations/conv_${CONV}`), () => client);
  assertEquals(res.status, 422);
  assertEquals((await body(res)).error.code, "unsupported_capability");
});

Deno.test("T10b: ?account_id= on a bound non-WhatsApp account is 422, not an empty page", async () => {
  // The filter path used to answer an empty 200 here while the resource read
  // answered 422 for the same account — the same lie this file's header
  // rejects, arriving through a query parameter instead.
  const client = stub({
    rows: {
      social_accounts: [{
        id: ACCT_BOUND,
        platform: "facebook",
        platform_user_id: "page-1",
        platform_username: "a page",
        is_active: true,
        needs_reauth: false,
        connected_at: "2026-08-01T00:00:00Z",
      }],
    },
  });
  const res = await handleRequest(
    v1(`/v1/conversations?account_id=acc_${ACCT_BOUND}`),
    () => client,
  );
  assertEquals(res.status, 422);
  assertEquals((await body(res)).error.code, "unsupported_capability");
});

Deno.test("T10c: the resource read excludes a null last_message_at, as the listing does", async () => {
  // The published Conversation schema types last_message_at as a string. The
  // listing excludes nulls to keep the cursor's ordering total; this route
  // must exclude them too or it can answer a row the contract forbids.
  const client = stub({
    rows: {
      messaging_cache: [{
        id: CONV,
        social_account_id: ACCT_BOUND,
        platform: "whatsapp",
        conversation_id: "wa_phone-1_1555",
        participant_name: "+1555",
        last_message_preview: "hi",
        last_message_at: "2026-08-01T00:00:00Z",
        unread_count: 0,
      }],
    },
  });
  await handleRequest(v1(`/v1/conversations/conv_${CONV}`), () => client);
  const lookup = queryFor(client, "messaging_cache")!;
  assertEquals(
    lookup.calls.some((c) => c[0] === "not" && c[1] === "last_message_at"),
    true,
    "the resource read must apply the same non-null exclusion as the listing",
  );
});

// --- T11 — the sub-resource cannot be laxer than its parent -----------------

Deno.test("T11: conversation messages carry BOTH the conversation key and the account", async () => {
  // whatsapp_messages has no workspace_id, and messaging_cache is unique on
  // (user_id, conversation_id) — so the same text conversation key exists for
  // two different users. Filtering on the text key alone reads another
  // tenant's messages. The account id is what carries the tenancy, because it
  // is the value the binding proved.
  const client = stub({
    rows: {
      messaging_cache: [{
        id: CONV,
        social_account_id: ACCT_BOUND,
        platform: "whatsapp",
        conversation_id: "wa_phone-1_1555",
        participant_name: "+1555",
        last_message_preview: "hi",
        last_message_at: "2026-08-01T00:00:00Z",
        unread_count: 0,
      }],
      whatsapp_messages: [{
        id: MSG,
        social_account_id: ACCT_BOUND,
        conversation_id: "wa_phone-1_1555",
        message_id: "wamid.ABC",
        message_text: "hello",
        message_type: "text",
        direction: "inbound",
        status: "delivered",
        timestamp: "2026-08-01T00:00:00Z",
      }],
    },
  });
  const res = await handleRequest(v1(`/v1/conversations/conv_${CONV}/messages`), () => client);
  assertEquals(res.status, 200);

  const messages = queryFor(client, "whatsapp_messages")!;
  assertEquals(filterArgs(messages, "eq", "conversation_id"), ["wa_phone-1_1555"]);
  assertEquals(
    filterArgs(messages, "eq", "social_account_id"),
    [ACCT_BOUND],
    "the account predicate is the tenancy proof, not a redundancy",
  );

  const item = (await body(res)).data[0];
  // The provider id is a separate, clearly named field (§7.1) and the primary
  // id is Postora's own.
  assertEquals(item.id, `msg_${MSG}`);
  assertEquals(item.provider_message_id, "wamid.ABC");
  // The text conversation key embeds the customer's phone number and must
  // never be published; the surrogate is what a partner sees.
  assertEquals(item.conversation_id, `conv_${CONV}`);
  assertEquals(JSON.stringify(item).includes("wa_phone-1_1555"), false);
});

// --- T12 — the one PostgREST string a stub cannot validate ------------------

Deno.test("T12: the keyset filter is ONE .or() disjunction, spelled once", () => {
  // Two things at once. The SHAPE: a cursor on the timestamp alone would
  // either re-emit a whole colliding group or drop all but one of it, and
  // history sync makes microsecond collisions routine rather than exotic.
  // The CALL COUNT: a second .or() on the same builder REPLACES the first
  // rather than AND-ing with it — this repo shipped that to production once
  // (PR #35).
  assertEquals(
    keysetFilter("last_message_at", { timestamp: "2026-08-01T00:00:00Z", id: CONV }),
    `last_message_at.lt.2026-08-01T00:00:00Z,` +
      `and(last_message_at.eq.2026-08-01T00:00:00Z,id.lt.${CONV})`,
  );

  const client = stub({
    rows: {
      messaging_cache: [{
        id: CONV,
        social_account_id: ACCT_BOUND,
        platform: "whatsapp",
        last_message_at: "2026-08-01T00:00:00Z",
        participant_name: "+1555",
        last_message_preview: "hi",
        unread_count: 0,
      }],
    },
  });
  const cursor = encodeCursor({ timestamp: "2026-08-02T00:00:00Z", id: CONV });
  return handleRequest(v1(`/v1/conversations?cursor=${cursor}`), () => client).then(() => {
    assertEquals(queryFor(client, "messaging_cache")!.or.length, 1);
  });
});

// --- T13 — pure helpers whose contract is the security property -------------

Deno.test("T13: decodeId refuses everything that is not a UUID of that prefix", () => {
  assertEquals(decodeId("acc", `acc_${ACCT_BOUND}`), ACCT_BOUND);
  assertEquals(decodeId("acc", `conv_${ACCT_BOUND}`), null, "prefix must match");
  assertEquals(decodeId("acc", "acc_"), null);
  // The loose-regex trap: a pattern of [0-9a-f-]+ would accept this.
  assertEquals(decodeId("acc", "acc_--------"), null);
  assertEquals(decodeId("acc", "acc_11111111-1111-4111-8111-11111111111"), null, "too short");
});

Deno.test("T13b: a cursor round-trips and survives URL encoding", () => {
  const position = { timestamp: "2026-08-01T00:00:00.123456Z", id: CONV };
  const encoded = encodeCursor(position);
  // base64url: none of these need escaping in a query string, so a cursor
  // cannot survive one client's HTTP library and not another's.
  assertEquals(/^[A-Za-z0-9_-]+$/.test(encoded), true, encoded);
  assertEquals(decodeCursor(encoded), position);
});

// --- T14 — the router still answers for the new paths -----------------------

Deno.test("T14: an unsupported method on a read route is 405 with Allow", async () => {
  const res = await handleRequest(v1("/v1/accounts", { method: "DELETE" }), () => stub());
  assertEquals(res.status, 405);
  assertEquals(res.headers.get("Allow"), "GET");
});

Deno.test("T14b: a read route without its scope answers insufficient_scope", async () => {
  const res = await handleRequest(
    v1("/v1/accounts"),
    () => stub({ keyRow: { ...KEY_ROW, scopes: ["conversations:read"] } }),
  );
  assertEquals(res.status, 403);
  assertEquals((await body(res)).error.code, "insufficient_scope");
});
