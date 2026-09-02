// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// Phase 5 webhook CRUD (5.6) and webhook.test (5.7).
//
// The two load-bearing tests are W1 and W2.
//
//   W1 is the D3 trap, written down in partnerScopes.ts as a warning to
//      exactly this commit: `whatsapp:webhooks.manage` authorises NOTHING, and
//      the obvious-looking move when the webhook API arrives is to let it
//      satisfy `webhooks:manage`. That one line converts zero capability into
//      full CRUD plus an SSRF-capable outbound test endpoint.
//
//   W2 is tenancy. A webhook id from another workspace must be unreachable and
//      indistinguishable from one that never existed -- and its control (W2b)
//      is what stops it passing against a route that refuses everything.
//
// The stub APPLIES its recorded .eq() filters rather than ignoring them, which
// is what makes W2 mean anything. That costs a real fixture: without a genuine
// key_hash every request 401s. Loosening the stub to avoid that would delete
// the test's whole subject.
// ---------------------------------------------------------------------------

const WS = "ws-1";
const WH = "77777777-7777-4777-8777-777777777777";
const OTHER_WH = "88888888-8888-4888-8888-888888888888";
const THIRD_WH = "99999999-9999-4999-8999-999999999999";
const ACCT = "22222222-2222-4222-8222-222222222222";

const KEY_ID = "key-1";
const TEST_KEY = "pk_live_test";
// Hashed once at module load so `stub()` stays SYNCHRONOUS: handleRequest calls
// the factory and uses its return value as a client, so an async factory would
// hand every route a Promise instead.
const KEY_HASH = await hashPartnerKey(TEST_KEY);

function webhookRow(overrides: Record<string, unknown> = {}) {
  return {
    id: WH,
    workspace_id: WS,
    created_by_key_id: KEY_ID,
    url: "https://hooks.example.com/postora",
    events: ["webhook.test"],
    platform: null,
    social_account_id: null,
    secret: "whsec_live",
    secret_version: 1,
    previous_secret: null,
    previous_secret_version: null,
    previous_secret_expires_at: null,
    is_active: true,
    consecutive_failures: 0,
    last_success_at: null,
    last_failure_at: null,
    last_error: null,
    disabled_at: null,
    disabled_reason: null,
    created_at: "2026-09-01T00:00:00Z",
  };
}

interface StubOpts {
  scopes?: string[];
  webhooks?: Record<string, unknown>[];
  /** Makes the partner_webhooks read fail rather than come back empty. */
  readFails?: boolean;
}

function stub(opts: StubOpts = {}) {
  const seeded: Record<string, any[]> = {
    partner_api_keys: [{
      id: KEY_ID,
      workspace_id: WS,
      social_account_id: ACCT,
      key_prefix: "pk_live_test",
      key_hash: KEY_HASH,
      scopes: opts.scopes ?? ["webhooks:manage", "webhooks:read"],
      rate_limit_per_min: 60,
      monthly_quota: null,
      expires_at: null,
      revoked_at: null,
    }],
    partner_api_key_accounts: [{ key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT }],
    partner_webhooks: opts.webhooks ?? [webhookRow()],
    partner_webhook_deliveries: [],
    partner_audit_logs: [],
  };
  const writes: Array<{ table: string; op: string; values: any }> = [];
  const rpcCalls: Array<{ name: string; args: any }> = [];

  function builder(table: string) {
    const filters: Array<[string, unknown]> = [];
    let pending: { op: string; values: any } | null = null;

    const matching = () =>
      (seeded[table] ?? []).filter((row) =>
        filters.every(([column, value]) => row[column] === value)
      );

    const self: any = {
      select: () => self,
      eq: (column: string, value: unknown) => (filters.push([column, value]), self),
      in: () => self,
      contains: () => self,
      order: () => self,
      insert: (values: any) => {
        pending = { op: "insert", values };
        writes.push({ table, op: "insert", values });
        const rows = (Array.isArray(values) ? values : [values]).map((row: any) => ({
          ...webhookRow(),
          ...row,
        }));
        if (table === "partner_webhooks") seeded[table].push(...rows);
        return {
          select: () => ({
            maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
          }),
          // partner_audit_logs is awaited directly, with no .select().
          then: (resolve: (v: unknown) => unknown) => resolve({ data: rows, error: null }),
        };
      },
      upsert: (rows: any[]) => {
        writes.push({ table, op: "upsert", values: rows });
        seeded[table].push(...rows);
        return {
          select: () =>
            Promise.resolve({ data: rows.map((_, i) => ({ id: `del-${i}` })), error: null }),
        };
      },
      update: (values: any) => {
        pending = { op: "update", values };
        return self;
      },
      delete: () => {
        pending = { op: "delete", values: null };
        return self;
      },
      maybeSingle: () => {
        if (opts.readFails && table === "partner_webhooks" && pending === null) {
          return Promise.resolve({ data: null, error: { message: "connection reset" } });
        }
        const rows = matching();
        if (pending && rows.length > 0) {
          writes.push({ table, op: pending.op, values: pending.values });
          if (pending.op === "update") Object.assign(rows[0], pending.values);
          if (pending.op === "delete") {
            seeded[table] = seeded[table].filter((row) => row !== rows[0]);
          }
        }
        return Promise.resolve({ data: rows[0] ?? null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: matching(), error: null }),
    };
    return self;
  }

  return {
    seeded,
    writes,
    rpcCalls,
    rpc(name: string, args?: any) {
      rpcCalls.push({ name, args });
      if (name === "rotate_partner_webhook_secret") {
        // Modelled on the SQL: workspace-scoped, and a SET-RETURNING function
        // reaches supabase-js as an ARRAY even for one row.
        const row = seeded.partner_webhooks.find((w: any) =>
          w.id === args.p_webhook_id && w.workspace_id === args.p_workspace_id
        );
        if (!row) return Promise.resolve({ data: [], error: null });
        const rotated = {
          ...row,
          previous_secret: row.secret,
          previous_secret_version: row.secret_version,
          previous_secret_expires_at: "2026-09-03T00:00:00Z",
          secret: args.p_new_secret,
          secret_version: row.secret_version + 1,
        };
        Object.assign(row, rotated);
        return Promise.resolve({ data: [rotated], error: null });
      }
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve({
          data: { allowed: true, remaining: 59, reset_seconds: 42 },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: builder,
  } as any;
}

function v1(path: string, init: RequestInit = {}) {
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    method: "GET",
    headers: { "x-postora-key": TEST_KEY, "content-type": "application/json" },
    ...init,
  });
}

async function code(res: Response): Promise<string> {
  return (await res.json()).error?.code ?? "";
}

// --- W1: the D3 trap -------------------------------------------------------

Deno.test("W1: whatsapp:webhooks.manage authorises NOTHING here", async () => {
  const legacyOnly = { scopes: ["whatsapp:webhooks.manage"] };

  const created = await handleRequest(
    v1("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/x", events: ["webhook.test"] }),
    }),
    () => stub(legacyOnly),
  );
  assertEquals(created.status, 403);
  assertEquals(await code(created), "insufficient_scope");

  // The test endpoint is the one that matters most: it makes Postora issue an
  // outbound request to a partner-supplied URL.
  const tested = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}/test`, { method: "POST" }),
    () => stub(legacyOnly),
  );
  assertEquals(await code(tested), "insufficient_scope");

  const listed = await handleRequest(
    v1("/v1/webhooks"),
    () => stub(legacyOnly),
  );
  assertEquals(await code(listed), "insufficient_scope");
});

Deno.test("W1b: the generic scopes DO authorise the same calls", async () => {
  // The control. Without it W1 would pass against routes that refused
  // everyone, which is a different bug wearing the same green tick.
  const created = await handleRequest(
    v1("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/x", events: ["webhook.test"] }),
    }),
    () => stub(),
  );
  assertEquals(created.status, 201);

  const listed = await handleRequest(v1("/v1/webhooks"), () => stub());
  assertEquals(listed.status, 200);
});

// --- W2: tenancy -----------------------------------------------------------

Deno.test("W2: another workspace's webhook is not found", async () => {
  const foreign = await stub({
    webhooks: [{ ...webhookRow(), id: OTHER_WH, workspace_id: "ws-2" }],
  });

  const res = await handleRequest(v1(`/v1/webhooks/wh_${OTHER_WH}`), () => foreign);

  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
  // Same answer as a webhook that never existed. `resource_forbidden` would
  // confirm the id names something real in some other tenant.
});

Deno.test("W2b: the same id in the caller's own workspace resolves", async () => {
  const res = await handleRequest(v1(`/v1/webhooks/wh_${WH}`), () => stub());
  assertEquals(res.status, 200);
  assertEquals((await res.json()).id, `wh_${WH}`);
});

Deno.test("W3: a malformed id is indistinguishable from an unknown one", async () => {
  const client = await stub();
  const res = await handleRequest(v1("/v1/webhooks/wh_not-a-uuid"), () => client);

  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
  // And it never reached the table: a non-UUID against a uuid column makes
  // PostgREST raise, which would be both a Postora 500 and an existence oracle.
  assertEquals(client.writes.filter((w: any) => w.table === "partner_webhooks").length, 0);
});

// --- W4: the secret ---------------------------------------------------------

Deno.test("W4: the secret is returned by create and by NOTHING else", async () => {
  const created = await handleRequest(
    v1("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({ url: "https://hooks.example.com/x", events: ["webhook.test"] }),
    }),
    () => stub(),
  );
  const body = await created.json();
  assert(String(body.secret).startsWith("whsec_"), "create hands the secret over once");

  const read = await handleRequest(v1(`/v1/webhooks/wh_${WH}`), () => stub());
  const readBody = await read.json();
  // A read that could return the secret would make every `webhooks:read` grant
  // a credential grant.
  assertEquals(readBody.secret, undefined);

  const listed = await handleRequest(v1("/v1/webhooks"), () => stub());
  assertEquals((await listed.json()).data[0].secret, undefined);
});

// --- W5: rotation ----------------------------------------------------------

Deno.test("W5: rotation supersedes the old secret and keeps it verifying", async () => {
  const client = await stub();
  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}/rotate-secret`, { method: "POST" }),
    () => client,
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assert(String(body.secret).startsWith("whsec_"));
  assertEquals(body.secret_version, 2);

  // ONE statement under a row lock, not a read followed by an update. Two
  // overlapping rotations reading version n and both writing n+1 would leave
  // the FIRST caller holding a secret that is neither current nor previous --
  // verifying nothing, during the overlap the rotation promised.
  const rotate = client.rpcCalls.find((c: any) => c.name === "rotate_partner_webhook_secret");
  assert(rotate, "rotation must go through the atomic function");
  assertEquals(rotate.args.p_workspace_id, WS);
  assertEquals(
    client.writes.filter((w: any) => w.op === "update" && w.table === "partner_webhooks").length,
    0,
    "a read-then-update rotation is the race this replaced",
  );
  // The superseded secret keeps verifying, and the window is bounded.
  assertEquals(body.previous_secret_expires_at, "2026-09-03T00:00:00Z");
  assertEquals(client.seeded.partner_webhooks[0].previous_secret, "whsec_live");

  const audit = client.writes.find((w: any) => w.table === "partner_audit_logs");
  assert(audit, "a rotation with no audit row is indistinguishable from a compromise");
  assertEquals(audit.values.action, "rotate");
});

// --- W6: webhook.test ------------------------------------------------------

Deno.test("W6: a test enqueues durably and answers 202, not 200", async () => {
  const client = await stub();
  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}/test`, { method: "POST" }),
    () => client,
  );

  // 202 because the event is QUEUED. A 200 would claim an outcome the outbox
  // exists precisely because Postora cannot yet know.
  assertEquals(res.status, 202);
  const enqueued = client.writes.find((w: any) => w.table === "partner_webhook_deliveries");
  assert(enqueued, "the test must reach the outbox, not the network");
  assertEquals(enqueued.values[0].event_type, "webhook.test");
  assertEquals(enqueued.values[0].webhook_id, WH);
  // The version captured at enqueue, so a retry after a rotation still signs
  // with the secret that was current when the event occurred.
  assertEquals(enqueued.values[0].secret_version, 1);
});

Deno.test("W6c: a test reaches ONE subscription, not every compatible one", async () => {
  // Fan-out is right for a real event -- a transition happened and everyone who
  // asked should hear. It is wrong here: this is a request to exercise ONE
  // endpoint. Without the restriction, a partner testing endpoint A posts that
  // test to endpoints B and C as well, and then reads the payload arriving at
  // B as evidence about A.
  const client = stub({
    webhooks: [
      webhookRow(),
      { ...webhookRow(), id: OTHER_WH, url: "https://hooks.example.com/other" },
      { ...webhookRow(), id: THIRD_WH, url: "https://hooks.example.com/third" },
    ],
  });

  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}/test`, { method: "POST" }),
    () => client,
  );

  assertEquals(res.status, 202);
  const enqueued = client.writes.filter((w: any) => w.table === "partner_webhook_deliveries");
  assertEquals(enqueued.length, 1);
  assertEquals(enqueued[0].values.length, 1, "three compatible subscriptions, one delivery");
  assertEquals(enqueued[0].values[0].webhook_id, WH);
});

Deno.test("W6b: a disabled webhook refuses a test", async () => {
  const client = await stub({
    webhooks: [{ ...webhookRow(), is_active: false, disabled_reason: "retry ladder exhausted" }],
  });
  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}/test`, { method: "POST" }),
    () => client,
  );

  assertEquals(await code(res), "invalid_request");
  assertEquals(
    client.writes.filter((w: any) => w.table === "partner_webhook_deliveries").length,
    0,
    "queueing for a disabled endpoint would build a backlog nothing drains",
  );
});

// --- W7/W8: what a subscription may say ------------------------------------

Deno.test("W7: only certified events may be subscribed to", async () => {
  const res = await handleRequest(
    v1("/v1/webhooks", {
      method: "POST",
      body: JSON.stringify({
        url: "https://hooks.example.com/x",
        events: ["message.received"],
      }),
    }),
    () => stub(),
  );

  // Phase 5 advertises no event family. A partner who could subscribe to
  // message.received would build against it and find out six weeks later that
  // it never fired.
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
});

Deno.test("W8: an internal target is refused at registration", async () => {
  for (const url of ["http://hooks.example.com/x", "https://169.254.169.254/latest", "https://localhost/x"]) {
    const res = await handleRequest(
      v1("/v1/webhooks", {
        method: "POST",
        body: JSON.stringify({ url, events: ["webhook.test"] }),
      }),
      () => stub(),
    );
    assertEquals(await code(res), "invalid_request", url);
  }
});

Deno.test("W9: a read ERROR is internal_error, never resource_not_found", async () => {
  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}`),
    () => stub({ readFails: true }),
  );

  // resource_not_found is non-retryable: answering it during a database blip
  // tells a partner to stop retrying something that exists and is theirs.
  assertEquals(res.status, 500);
  assertEquals(await code(res), "internal_error");
});

Deno.test("W10: re-enabling a disabled webhook clears the disabled reason", async () => {
  const client = await stub({
    webhooks: [{
      ...webhookRow(),
      is_active: false,
      disabled_at: "2026-09-01T10:00:00Z",
      disabled_reason: "retry ladder exhausted",
      consecutive_failures: 6,
    }],
  });

  const res = await handleRequest(
    v1(`/v1/webhooks/wh_${WH}`, { method: "PATCH", body: JSON.stringify({ is_active: true }) }),
    () => client,
  );

  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.is_active, true);
  // Leaving the reason behind would show an active subscription still claiming
  // it was disabled -- the state a partner reads to decide whether their fix
  // worked.
  assertEquals(body.health.disabled_reason, null);
  assertEquals(body.health.consecutive_failures, 0);
});
