// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// GET /v1/connectors and POST /v1/connectors/{type}/connect-link (spec §8.2).
//
// The load-bearing groups are the two the spec names explicitly:
//
//   TENANCY   — a tool the key's accounts cannot resolve, a tool owned by
//               another login, and a connection in another workspace must be
//               invisible. The stub APPLIES the recorded .eq/.in/.gte filters
//               to seeded rows, so a handler that forgot a workspace predicate
//               fails these instead of passing vacuously.
//   DISCLOSURE— spec §11 forbids `composio_connected_account_id`,
//               `composio_auth_config_id` and another workspace's connection id
//               from ever reaching a partner. Asserted against the whole
//               serialized body, not field by field: a field-by-field check
//               only catches the leaks someone thought of.
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

const ACCT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCT_B = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCT_UNBOUND = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const TOOL_SHARED = "10000000-0000-4000-8000-000000000001";
const TOOL_COMPOSIO = "10000000-0000-4000-8000-000000000002";
const TOOL_OTHER_OWNER = "10000000-0000-4000-8000-000000000003";
const TOOL_DISABLED = "10000000-0000-4000-8000-000000000004";
const TOOL_ADMIN_ONLY = "10000000-0000-4000-8000-000000000005";

const CONN_ACTIVE = "20000000-0000-4000-8000-000000000001";
const CONN_OTHER_WS = "20000000-0000-4000-8000-000000000002";

/** Values that must never appear in a partner-facing body (spec §11). */
const COMPOSIO_ACCOUNT_ID = "ca_composio_secret_id";
const COMPOSIO_AUTH_CONFIG_ID = "ac_composio_secret_id";

const KEY_ID = "key-1";
const TEST_KEY = "pk_live_test";
const KEY_HASH = await hashPartnerKey(TEST_KEY);

const DEFAULT_KEY_ROW = {
  id: KEY_ID,
  workspace_id: WS,
  social_account_id: ACCT_A,
  created_by: USER_ID,
  key_prefix: "pk_live_test",
  key_hash: KEY_HASH,
  scopes: ["connectors:read", "connectors:manage"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

const BOUND_ACCOUNTS = [
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_A },
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_B },
];

const SOCIAL_ACCOUNTS = [
  { id: ACCT_A, user_id: USER_ID, workspace_id: WS },
  { id: ACCT_B, user_id: USER_ID, workspace_id: WS },
  { id: ACCT_UNBOUND, user_id: USER_ID, workspace_id: WS },
];

const AI_AGENT_TOOLS = [
  {
    id: TOOL_SHARED,
    user_id: USER_ID,
    name: "catalogue",
    description: "the shop database",
    url: "https://db.invalid",
    secret: null,
    admin_only: false,
    scope: "all_accounts",
    social_account_id: null,
    connector_type: "supabase",
    settings: { allowed_tables: ["products"] },
    auth_strategy: "manual_credentials",
    connection_id: null,
    is_enabled: true,
  },
  {
    id: TOOL_COMPOSIO,
    user_id: USER_ID,
    name: "slack",
    description: "the team workspace",
    url: null,
    secret: null,
    admin_only: false,
    scope: "account",
    social_account_id: ACCT_A,
    connector_type: "slack",
    settings: { allow_writes: false },
    auth_strategy: "composio_oauth",
    connection_id: CONN_ACTIVE,
    is_enabled: true,
  },
  {
    id: TOOL_OTHER_OWNER,
    user_id: OTHER_USER_ID,
    name: "someone-elses",
    description: "another login's connector",
    url: "https://other.invalid",
    secret: null,
    admin_only: false,
    scope: "all_accounts",
    social_account_id: null,
    connector_type: "supabase",
    settings: null,
    auth_strategy: "manual_credentials",
    connection_id: null,
    is_enabled: true,
  },
  {
    id: TOOL_DISABLED,
    user_id: USER_ID,
    name: "switched-off",
    description: "disabled connector",
    url: "https://off.invalid",
    secret: null,
    admin_only: false,
    scope: "all_accounts",
    social_account_id: null,
    connector_type: "supabase",
    settings: null,
    auth_strategy: "manual_credentials",
    connection_id: null,
    is_enabled: false,
  },
  {
    id: TOOL_ADMIN_ONLY,
    user_id: USER_ID,
    name: "staff-only",
    description: "admin connector",
    url: "https://staff.invalid",
    secret: null,
    admin_only: true,
    scope: "all_accounts",
    social_account_id: null,
    connector_type: "supabase",
    settings: null,
    auth_strategy: "manual_credentials",
    connection_id: null,
    is_enabled: true,
  },
];

const CONNECTIONS = [
  {
    id: CONN_ACTIVE,
    workspace_id: WS,
    connector_type: "slack",
    status: "active",
    external_account_label: "acme.slack.com",
    composio_connected_account_id: COMPOSIO_ACCOUNT_ID,
    composio_auth_config_id: COMPOSIO_AUTH_CONFIG_ID,
  },
  {
    id: CONN_OTHER_WS,
    workspace_id: OTHER_WS,
    connector_type: "slack",
    status: "active",
    external_account_label: "rival.slack.com",
    composio_connected_account_id: "ca_other_workspace",
    composio_auth_config_id: "ac_other_workspace",
  },
];

const RECENT = new Date(Date.now() - 2 * 86_400_000).toISOString();
const OLDER_RECENT = new Date(Date.now() - 3 * 86_400_000).toISOString();
const OUTSIDE_WINDOW = new Date(Date.now() - 40 * 86_400_000).toISOString();

const CALL_LOGS = [
  { workspace_id: WS, tool_id: TOOL_SHARED, status: "success", latency_ms: 100, created_at: OLDER_RECENT },
  { workspace_id: WS, tool_id: TOOL_SHARED, status: "success", latency_ms: 200, created_at: OLDER_RECENT },
  { workspace_id: WS, tool_id: TOOL_SHARED, status: "failed", latency_ms: 300, created_at: RECENT },
  { workspace_id: WS, tool_id: TOOL_SHARED, status: "timeout", latency_ms: 400, created_at: RECENT },
  // Outside the 30-day window: must not be counted.
  { workspace_id: WS, tool_id: TOOL_SHARED, status: "success", latency_ms: 9999, created_at: OUTSIDE_WINDOW },
  // Another workspace's ledger: must not be counted.
  { workspace_id: OTHER_WS, tool_id: TOOL_SHARED, status: "success", latency_ms: 5000, created_at: RECENT },
];

interface Filter {
  col: string;
  op: "eq" | "in" | "gte";
  val: unknown;
}

interface StubOpts {
  keyRow?: unknown;
  boundAccounts?: Record<string, unknown>[];
  tools?: Record<string, unknown>[];
  connections?: Record<string, unknown>[];
  callLogs?: Record<string, unknown>[];
  /** What claim_partner_idempotency answers; defaults to a fresh claim. */
  claim?: Record<string, unknown>;
}

function stub(opts: StubOpts = {}) {
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const inserts: Array<{ table: string; row: any }> = [];

  const seeded: Record<string, Record<string, unknown>[]> = {
    partner_api_keys: [(opts.keyRow ?? DEFAULT_KEY_ROW) as Record<string, unknown>],
    partner_api_key_accounts: opts.boundAccounts ?? [...BOUND_ACCOUNTS],
    social_accounts: [...SOCIAL_ACCOUNTS],
    ai_agent_tools: opts.tools ?? AI_AGENT_TOOLS.map((t) => ({ ...t })),
    ai_agent_tool_accounts: [],
    connector_connections: opts.connections ?? CONNECTIONS.map((c) => ({ ...c })),
    connector_call_logs: opts.callLogs ?? CALL_LOGS.map((c) => ({ ...c })),
    partner_api_usage: [],
  };

  function builder(table: string) {
    const filters: Filter[] = [];
    const matching = () =>
      (seeded[table] ?? []).filter((row) =>
        filters.every((f) => {
          if (f.op === "eq") return row[f.col] === f.val;
          if (f.op === "in") return (Array.isArray(f.val) ? f.val : []).includes(row[f.col]);
          if (f.op === "gte") return String(row[f.col]) >= String(f.val);
          return true;
        })
      );

    const self: any = {
      select: () => self,
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        return self;
      },
      in: (col: string, val: unknown) => {
        filters.push({ col, op: "in", val });
        return self;
      },
      gte: (col: string, val: unknown) => {
        filters.push({ col, op: "gte", val });
        return self;
      },
      order: () => self,
      limit: () => self,
      insert: (row: any) => {
        inserts.push({ table, row });
        (seeded[table] ??= []).push(row);
        return Promise.resolve({ error: null });
      },
      update: (values: any) => {
        const rows = matching();
        for (const row of rows) Object.assign(row, values);
        return self;
      },
      maybeSingle: () => {
        const rows = matching();
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) =>
        resolve({ data: matching().map((r) => ({ ...r })), error: null }),
    };
    return self;
  }

  return {
    rpcCalls,
    inserts,
    seeded,
    rpc: (name: string, args?: any) => {
      rpcCalls.push({ name, args });
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve({
          data: { allowed: true, remaining: 59, reset_seconds: 42 },
          error: null,
        });
      }
      if (name === "claim_partner_idempotency") {
        return Promise.resolve({
          data: opts.claim ?? { outcome: "claimed", attempt_token: "tok-1" },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: builder,
  } as any;
}

const COMPOSIO_ENV = {
  COMPOSIO_API_KEY: "composio-test-key",
  COMPOSIO_STATE_SECRET: "state-secret",
  COMPOSIO_CALLBACK_URL: "https://api.postora.invalid/functions/v1/composio-connect/callback",
  COMPOSIO_AUTH_CONFIG_SLACK: "auth-config-slack",
};

/** Sets every variable EXPLICITLY, `null` for "unset". A test that only sets
 *  the variables it wants present passes or fails on whatever the developer's
 *  shell happens to hold. */
function withComposioEnv(values: Record<string, string | null>): () => void {
  const previous: Record<string, string | undefined> = {};
  for (const [name, value] of Object.entries(values)) {
    previous[name] = Deno.env.get(name);
    if (value === null) Deno.env.delete(name);
    else Deno.env.set(name, value);
  }
  return () => {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(name);
      else Deno.env.set(name, value);
    }
  };
}

/** Composio's initiate endpoint, at the fetch boundary. */
function withComposioFetch(
  respond: () => Response,
): { restore: () => void; calls: string[] } {
  const original = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = ((input: any) => {
    calls.push(typeof input === "string" ? input : String(input?.url ?? input));
    return Promise.resolve(respond());
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

function v1(path: string, init: RequestInit = {}) {
  const customHeaders = init.headers ? (init.headers as Record<string, string>) : {};
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    ...init,
    headers: { "x-postora-key": TEST_KEY, ...customHeaders },
  });
}

function connectLinkReq(type: string, headers: Record<string, string> = {}, body: unknown = {}) {
  return v1(`/v1/connectors/${type}/connect-link`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-connect-1",
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function code(res: Response): Promise<string | null> {
  return (await res.json().catch(() => ({})))?.error?.code ?? null;
}

// ===========================================================================
// GET /v1/connectors
// ===========================================================================

Deno.test("a key bound to no account lists no connectors at all", async () => {
  const client = stub({ boundAccounts: [] });
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  assertEquals(res.status, 200);
  assertEquals(await res.json(), { data: [], next_cursor: null });
});

Deno.test("one all_accounts tool resolvable by two bound accounts is listed once", async () => {
  const client = stub();
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  const body = await res.json() as any;
  assertEquals(
    body.data.filter((e: any) => e.tool_id === TOOL_SHARED).length,
    1,
    "a tool both bound accounts resolve must not be listed twice",
  );
});

Deno.test("a listed entry carries the documented fields and its 30-day usage", async () => {
  const client = stub();
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  const body = await res.json() as any;
  const shared = body.data.find((e: any) => e.tool_id === TOOL_SHARED);
  assertEquals(shared, {
    tool_id: TOOL_SHARED,
    name: "catalogue",
    connector_type: "supabase",
    auth_strategy: "manual_credentials",
    category: "databases",
    scope: "all_accounts",
    social_account_id: null,
    connection: null,
    usage_30d: {
      // The two rows outside the window and in another workspace are excluded.
      calls: 4,
      failures: 2,
      // percentile_cont(0.5) over [100,200,300,400], the same definition the
      // workspace_connector_usage RPC uses.
      p50_latency_ms: 250,
      last_used_at: RECENT,
    },
  });
  assertEquals(body.next_cursor, null);
});

Deno.test("a Composio-backed entry shows its connection state and no Composio identifier", async () => {
  const client = stub();
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  const raw = await res.text();
  const body = JSON.parse(raw) as any;
  const composio = body.data.find((e: any) => e.tool_id === TOOL_COMPOSIO);
  assertEquals(composio.auth_strategy, "composio_oauth");
  assertEquals(composio.social_account_id, ACCT_A);
  assertEquals(composio.connection, { status: "active", external_account_label: "acme.slack.com" });
  for (const secret of [COMPOSIO_ACCOUNT_ID, COMPOSIO_AUTH_CONFIG_ID, CONN_ACTIVE, CONN_OTHER_WS]) {
    assert(!raw.includes(secret), `the response leaked ${secret}`);
  }
});

Deno.test("tools owned by another login, disabled tools and admin-only tools are never listed", async () => {
  const client = stub();
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  const body = await res.json() as any;
  const listed = body.data.map((e: any) => e.tool_id).sort();
  assertEquals(listed, [TOOL_SHARED, TOOL_COMPOSIO].sort());
});

Deno.test("a key without connectors:read is refused with insufficient_scope", async () => {
  const client = stub({ keyRow: { ...DEFAULT_KEY_ROW, scopes: ["connectors:manage"] } });
  const res = await handleRequest(v1("/v1/connectors"), () => client);
  assertEquals(res.status, 403);
  assertEquals(await code(res), "insufficient_scope");
});

// ===========================================================================
// POST /v1/connectors/{type}/connect-link
// ===========================================================================

Deno.test("a connect-link request without an Idempotency-Key is refused", async () => {
  const client = stub();
  const req = v1("/v1/connectors/slack/connect-link", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  const res = await handleRequest(req, () => client);
  assertEquals(res.status, 400);
  assertEquals(await code(res), "missing_idempotency_key");
});

Deno.test("a connector type that cannot be connected is refused before any state is written", async () => {
  const client = stub();
  const res = await handleRequest(connectLinkReq("supabase"), () => client);
  assertEquals(res.status, 400);
  assertEquals(await code(res), "connector_type_not_connectable");
  assertEquals(client.seeded.connector_connections.length, CONNECTIONS.length);
});

Deno.test("an unknown connector type is refused the same way, teaching nothing", async () => {
  const client = stub();
  const res = await handleRequest(connectLinkReq("not_a_connector"), () => client);
  assertEquals(res.status, 400);
  assertEquals(await code(res), "connector_type_not_connectable");
});

Deno.test("a connect link is minted, attributed to the key, and metered as a partner call", async () => {
  const restoreEnv = withComposioEnv(COMPOSIO_ENV);
  const composio = withComposioFetch(() =>
    new Response(JSON.stringify({ id: "req-1", redirect_url: "https://slack.invalid/oauth" }), {
      status: 200,
      headers: { "content-type": "application/json" },
    })
  );
  try {
    const client = stub();
    const res = await handleRequest(connectLinkReq("slack"), () => client);
    assertEquals(res.status, 201);
    const body = await res.json() as any;
    assertEquals(body.redirect_url, "https://slack.invalid/oauth");
    assertEquals(typeof body.connection_id, "string");
    assertEquals(typeof body.expires_at, "string");

    // The pending row exists, in the key's workspace, before the link was used.
    const pending = client.seeded.connector_connections.find((c: any) => c.id === body.connection_id);
    assertEquals(pending?.status, "initiated");
    assertEquals(pending?.workspace_id, WS);
    assertEquals(pending?.initiated_by, USER_ID);

    // Spec §8.2: the ledger row AND the ordinary non-billable usage row.
    const ledger = client.inserts.find((i) => i.table === "connector_call_logs");
    assertEquals(ledger?.row.source, "partner");
    assertEquals(ledger?.row.status, "success");
    assertEquals(ledger?.row.action_name, "connect_link");
    assertEquals(ledger?.row.partner_key_id, KEY_ID);
    assertEquals(ledger?.row.request_id, res.headers.get("X-Postora-Request-Id"));

    const usage = client.inserts.find((i) => i.table === "partner_api_usage");
    assertEquals(usage?.row.action, "create_connect_link");
    assertEquals(usage?.row.billable, false);
  } finally {
    composio.restore();
    restoreEnv();
  }
});

Deno.test("a replayed connect-link returns the stored link without minting a second one", async () => {
  const restoreEnv = withComposioEnv(COMPOSIO_ENV);
  const composio = withComposioFetch(() => new Response("{}", { status: 200 }));
  try {
    const stored = {
      connection_id: CONN_ACTIVE,
      redirect_url: "https://slack.invalid/first",
      expires_at: "2026-09-03T12:00:00.000Z",
    };
    const client = stub({
      claim: { outcome: "replay", http_status: 201, response_body: stored },
    });
    const res = await handleRequest(connectLinkReq("slack"), () => client);
    assertEquals(res.status, 201);
    assertEquals(await res.json(), stored);
    assertEquals(res.headers.get("Idempotency-Replayed"), "true");
    assertEquals(composio.calls.length, 0, "a replay must not reach the connector service");
  } finally {
    composio.restore();
    restoreEnv();
  }
});

Deno.test("the connector service being unconfigured refuses with connector_unavailable and a refused row", async () => {
  const restoreEnv = withComposioEnv({
    COMPOSIO_API_KEY: null,
    COMPOSIO_STATE_SECRET: null,
    COMPOSIO_CALLBACK_URL: null,
    COMPOSIO_AUTH_CONFIG_SLACK: null,
  });
  try {
    const client = stub();
    const res = await handleRequest(connectLinkReq("slack"), () => client);
    assertEquals(res.status, 503);
    assertEquals(await code(res), "connector_unavailable");
    const ledger = client.inserts.find((i) => i.table === "connector_call_logs");
    assertEquals(ledger?.row.status, "refused");
    assertEquals(ledger?.row.error_code, "connector_unavailable");
    assertEquals(ledger?.row.partner_key_id, KEY_ID);
  } finally {
    restoreEnv();
  }
});
