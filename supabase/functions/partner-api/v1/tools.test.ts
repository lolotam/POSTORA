// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";

// ---------------------------------------------------------------------------
// POST /v1/tools/execute (spec §8.2).
//
// The load-bearing groups:
//
//   AUTHORISATION — the SAME resolver the agent uses. An account the key is not
//     bound to, a tool that does not resolve for that account, and an unknown
//     id are one non-enumerable 404 (D11), and each leaves a `refused` row.
//   GATES         — the §7.2 rules, restated for a typed envelope: the registry
//     allow-list, then `allow_writes` for a mutating slug. A partner key can
//     never widen what the tool's owner allowed.
//   LEDGER        — every outcome writes connector_call_logs with
//     source='partner', the key id and the response's request id (D5).
//
// The Supabase boundary is stubbed with a stub that APPLIES the recorded
// filters, and the two outbound calls (the adapter, Composio) are stubbed at
// `fetch`. Nothing internal is asserted by name.
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";

const ACCT_A = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCT_UNBOUND = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

const TOOL_NATIVE = "10000000-0000-4000-8000-000000000001";
const TOOL_COMPOSIO = "10000000-0000-4000-8000-000000000002";
const TOOL_WEBHOOK = "10000000-0000-4000-8000-000000000003";
const TOOL_ADMIN_ONLY = "10000000-0000-4000-8000-000000000004";
const TOOL_UNKNOWN = "10000000-0000-4000-8000-00000000000f";

const CONN_ACTIVE = "20000000-0000-4000-8000-000000000001";
const CONN_REVOKED = "20000000-0000-4000-8000-000000000002";
const CONN_OTHER_WS = "20000000-0000-4000-8000-000000000003";
const COMPOSIO_ACCOUNT_ID = "ca_composio_secret_id";

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
  scopes: ["tools:execute"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

function tool(overrides: Record<string, unknown>) {
  return {
    id: TOOL_NATIVE,
    user_id: USER_ID,
    name: "catalogue",
    description: "the shop database",
    url: "https://db.invalid",
    secret: null,
    admin_only: false,
    scope: "account",
    social_account_id: ACCT_A,
    connector_type: "supabase",
    settings: null,
    auth_strategy: "manual_credentials",
    connection_id: null,
    is_enabled: true,
    ...overrides,
  };
}

const AI_AGENT_TOOLS = [
  tool({}),
  tool({
    id: TOOL_COMPOSIO,
    name: "slack",
    connector_type: "slack",
    auth_strategy: "composio_oauth",
    connection_id: CONN_ACTIVE,
    settings: { allow_writes: false },
    url: null,
  }),
  tool({ id: TOOL_WEBHOOK, name: "webhook", connector_type: "custom_rest" }),
  tool({ id: TOOL_ADMIN_ONLY, name: "staff", admin_only: true }),
];

const CONNECTIONS = [
  {
    id: CONN_ACTIVE,
    workspace_id: WS,
    connector_type: "slack",
    toolkit: "slack",
    status: "active",
    external_account_label: "acme.slack.com",
    composio_connected_account_id: COMPOSIO_ACCOUNT_ID,
    tool_schema_cache: [],
  },
  {
    id: CONN_REVOKED,
    workspace_id: WS,
    connector_type: "slack",
    toolkit: "slack",
    status: "revoked",
    external_account_label: null,
    composio_connected_account_id: null,
    tool_schema_cache: [],
  },
  {
    id: CONN_OTHER_WS,
    workspace_id: OTHER_WS,
    connector_type: "slack",
    toolkit: "slack",
    status: "active",
    external_account_label: "rival.slack.com",
    composio_connected_account_id: "ca_other",
    tool_schema_cache: [],
  },
];

interface Filter {
  col: string;
  op: "eq" | "in";
  val: unknown;
}

interface StubOpts {
  keyRow?: unknown;
  tools?: Record<string, unknown>[];
  boundAccounts?: Record<string, unknown>[];
  claim?: Record<string, unknown>;
}

function stub(opts: StubOpts = {}) {
  const inserts: Array<{ table: string; row: any }> = [];
  const updates: Array<{ table: string; values: any }> = [];
  const rpcNames: string[] = [];

  const seeded: Record<string, Record<string, unknown>[]> = {
    partner_api_keys: [(opts.keyRow ?? DEFAULT_KEY_ROW) as Record<string, unknown>],
    partner_api_key_accounts: opts.boundAccounts ??
      [{ key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_A }],
    social_accounts: [
      { id: ACCT_A, user_id: USER_ID, workspace_id: WS },
      { id: ACCT_UNBOUND, user_id: USER_ID, workspace_id: WS },
    ],
    ai_agent_tools: opts.tools ?? AI_AGENT_TOOLS.map((t) => ({ ...t })),
    ai_agent_tool_accounts: [],
    connector_connections: CONNECTIONS.map((c) => ({ ...c })),
    connector_call_logs: [],
    partner_api_usage: [],
    partner_api_idempotency: [],
  };

  function builder(table: string) {
    const filters: Filter[] = [];
    const matching = () =>
      (seeded[table] ?? []).filter((row) =>
        filters.every((f) =>
          f.op === "eq"
            ? row[f.col] === f.val
            : (Array.isArray(f.val) ? f.val : []).includes(row[f.col])
        )
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
      gte: () => self,
      order: () => self,
      limit: () => self,
      insert: (row: any) => {
        inserts.push({ table, row });
        (seeded[table] ??= []).push(row);
        return Promise.resolve({ error: null });
      },
      update: (values: any) => {
        updates.push({ table, values });
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
    inserts,
    updates,
    seeded,
    rpcNames,
    rpc: (name: string) => {
      rpcNames.push(name);
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

interface FetchCall {
  url: string;
  body: any;
}

/** The two outbound calls this route can make, at the fetch boundary. */
function withFetch(
  respond: (call: FetchCall) => Response | Promise<Response>,
): { restore: () => void; calls: FetchCall[] } {
  const original = globalThis.fetch;
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    let body: any = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch { /* not JSON; the assertions that care use adapter calls */ }
    const call = { url, body };
    calls.push(call);
    return await respond(call);
  }) as typeof fetch;
  return { restore: () => (globalThis.fetch = original), calls };
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** The adapter and Composio env this route reads. */
function withEnv(values: Record<string, string | null>): () => void {
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

const ADAPTER_ENV = {
  SUPABASE_URL: "http://kong.internal",
  SUPABASE_SERVICE_ROLE_KEY: "service-role-key",
  COMPOSIO_API_KEY: "composio-test-key",
};

function executeReq(payload: unknown, headers: Record<string, string> = {}) {
  return new Request("https://partner.example/functions/v1/partner-api/v1/tools/execute", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-postora-key": TEST_KEY,
      "idempotency-key": "idem-exec-1",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

const NATIVE_BODY = {
  tool_id: TOOL_NATIVE,
  social_account_id: ACCT_A,
  capability: "search_products",
  parameters: { table: "products" },
};

const COMPOSIO_BODY = {
  tool_id: TOOL_COMPOSIO,
  social_account_id: ACCT_A,
  capability: "SLACK_SEARCH_MESSAGES",
  parameters: { query: "order 10432" },
};

async function code(res: Response): Promise<string | null> {
  return (await res.json().catch(() => ({})))?.error?.code ?? null;
}

function ledgerRows(client: any) {
  return client.inserts.filter((i: any) => i.table === "connector_call_logs").map((i: any) => i.row);
}

// ===========================================================================
// AUTHORISATION
// ===========================================================================

Deno.test("an account the key is not bound to answers tool_not_found and is metered as refused", async () => {
  const client = stub();
  const res = await handleRequest(
    executeReq({ ...NATIVE_BODY, social_account_id: ACCT_UNBOUND }),
    () => client,
  );
  assertEquals(res.status, 404);
  assertEquals(await code(res), "tool_not_found");
  const rows = ledgerRows(client);
  assertEquals(rows.length, 1);
  assertEquals(rows[0].source, "partner");
  assertEquals(rows[0].status, "refused");
  assertEquals(rows[0].error_code, "tool_not_found");
  assertEquals(rows[0].partner_key_id, KEY_ID);
  assertEquals(rows[0].workspace_id, WS);
});

Deno.test("an unknown tool id and an admin-only tool are the same 404, teaching nothing", async () => {
  for (const toolId of [TOOL_UNKNOWN, TOOL_ADMIN_ONLY]) {
    const client = stub();
    const res = await handleRequest(executeReq({ ...NATIVE_BODY, tool_id: toolId }), () => client);
    assertEquals(res.status, 404);
    assertEquals(await code(res), "tool_not_found");
  }
});

Deno.test("a malformed id answers as an unknown one rather than as a bad request", async () => {
  const client = stub();
  const res = await handleRequest(executeReq({ ...NATIVE_BODY, tool_id: "not-a-uuid" }), () => client);
  assertEquals(res.status, 404);
  assertEquals(await code(res), "tool_not_found");
});

Deno.test("a key without tools:execute is refused with insufficient_scope", async () => {
  const client = stub({ keyRow: { ...DEFAULT_KEY_ROW, scopes: ["connectors:read"] } });
  const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
  assertEquals(res.status, 403);
  assertEquals(await code(res), "insufficient_scope");
});

Deno.test("a request without an Idempotency-Key is refused before anything is resolved", async () => {
  const client = stub();
  const req = new Request("https://partner.example/functions/v1/partner-api/v1/tools/execute", {
    method: "POST",
    headers: { "content-type": "application/json", "x-postora-key": TEST_KEY },
    body: JSON.stringify(NATIVE_BODY),
  });
  const res = await handleRequest(req, () => client);
  assertEquals(res.status, 400);
  assertEquals(await code(res), "missing_idempotency_key");
  assertEquals(ledgerRows(client).length, 0);
});

// ===========================================================================
// NATIVE (adapter) EXECUTION
// ===========================================================================

Deno.test("a native tool reaches the adapter with the tool's OWNER and answers with its data", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ ok: true, data: { rows: [{ sku: "A1" }] } }));
  try {
    const client = stub();
    const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
    assertEquals(res.status, 200);
    const body = await res.json() as any;
    assertEquals(body.ok, true);
    assertEquals(body.data, { rows: [{ sku: "A1" }] });
    assertEquals(body.request_id, res.headers.get("X-Postora-Request-Id"));
    assertEquals(typeof body.latency_ms, "number");

    assertEquals(outbound.calls.length, 1);
    assert(outbound.calls[0].url.endsWith("/functions/v1/ai-agent-adapters"));
    assertEquals(outbound.calls[0].body, {
      tool_id: TOOL_NATIVE,
      user_id: USER_ID,
      action: "execute",
      capability: "search_products",
      parameters: { table: "products" },
    });

    const rows = ledgerRows(client);
    assertEquals(rows.length, 1);
    assertEquals(rows[0].source, "partner");
    assertEquals(rows[0].status, "success");
    assertEquals(rows[0].partner_key_id, KEY_ID);
    assertEquals(rows[0].tool_id, TOOL_NATIVE);
    assertEquals(rows[0].action_name, "search_products");
    assertEquals(rows[0].request_id, res.headers.get("X-Postora-Request-Id"));

    const usage = client.inserts.find((i: any) => i.table === "partner_api_usage");
    assertEquals(usage?.row.action, "execute_tool");
    assertEquals(usage?.row.billable, false);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("an adapter that answers ok:false is a 502 carrying the code and no vendor text", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() =>
    json({
      ok: false,
      vendor: "supabase",
      error: { code: "vendor_rejected", message: "relation \"secrets\" does not exist", vendor_status: 400 },
    })
  );
  try {
    const client = stub();
    const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
    assertEquals(res.status, 502);
    const raw = await res.text();
    assertEquals(JSON.parse(raw).error.code, "tool_execution_failed");
    assert(!raw.includes("secrets"), "the vendor's message must not pass through");
    const rows = ledgerRows(client);
    assertEquals(rows[0].status, "failed");
    // The definite failure is SETTLED as a 502, so a retry with the same key
    // replays it instead of executing the call again (connectors.md contract).
    const settled = client.updates.find((u: any) => u.table === "partner_api_idempotency");
    assertEquals(settled?.values.http_status, 502);
    assertEquals(settled?.values.state, "completed");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a capability the connector does not define is refused before the adapter is called", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ ok: true, data: {} }));
  try {
    const client = stub();
    const res = await handleRequest(
      executeReq({ ...NATIVE_BODY, capability: "drop_everything" }),
      () => client,
    );
    assertEquals(res.status, 403);
    assertEquals(await code(res), "connector_tool_not_allowed");
    assertEquals(outbound.calls.length, 0);
    assertEquals(ledgerRows(client)[0].status, "refused");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a connector with no adapter is not executable headlessly", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ ok: true, data: {} }));
  try {
    const client = stub();
    const res = await handleRequest(
      executeReq({ ...NATIVE_BODY, tool_id: TOOL_WEBHOOK }),
      () => client,
    );
    assertEquals(res.status, 403);
    assertEquals(await code(res), "connector_tool_not_allowed");
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("an unconfigured adapter answers connector_unavailable and never invents a result", async () => {
  const restoreEnv = withEnv({ ...ADAPTER_ENV, SUPABASE_URL: null });
  const outbound = withFetch(() => json({ ok: true, data: {} }));
  try {
    const client = stub();
    const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
    assertEquals(res.status, 503);
    assertEquals(await code(res), "connector_unavailable");
    assertEquals(outbound.calls.length, 0);
    assertEquals(ledgerRows(client)[0].status, "refused");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("an aborted call is a 504 and is marked indeterminate, never replayed as a result", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => {
    throw new DOMException("Aborted", "AbortError");
  });
  try {
    const client = stub();
    const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
    assertEquals(res.status, 504);
    assertEquals(await code(res), "tool_execution_timeout");
    assertEquals(ledgerRows(client)[0].status, "timeout");
    const settled = client.updates.find((u: any) => u.table === "partner_api_idempotency");
    assertEquals(settled?.values.state, "indeterminate");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a replay returns the stored body without executing a second time", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ ok: true, data: {} }));
  try {
    const stored = { ok: true, data: { rows: [] }, request_id: "req-first", latency_ms: 12 };
    const client = stub({ claim: { outcome: "replay", http_status: 200, response_body: stored } });
    const res = await handleRequest(executeReq(NATIVE_BODY), () => client);
    assertEquals(res.status, 200);
    assertEquals(await res.json(), stored);
    assertEquals(res.headers.get("Idempotency-Replayed"), "true");
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

// ===========================================================================
// COMPOSIO EXECUTION
// ===========================================================================

Deno.test("a Composio tool executes against its connected account with the workspace as the entity", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ successful: true, data: { messages: [] } }));
  try {
    const client = stub();
    const res = await handleRequest(executeReq(COMPOSIO_BODY), () => client);
    assertEquals(res.status, 200);
    assertEquals((await res.json() as any).data, { messages: [] });
    assertEquals(outbound.calls.length, 1);
    assert(outbound.calls[0].url.endsWith("/tools/execute/SLACK_SEARCH_MESSAGES"));
    assertEquals(outbound.calls[0].body.user_id, WS);
    assertEquals(outbound.calls[0].body.connected_account_id, COMPOSIO_ACCOUNT_ID);
    assertEquals(outbound.calls[0].body.arguments, { query: "order 10432" });
    const rows = ledgerRows(client);
    assertEquals(rows[0].auth_strategy, "composio_oauth");
    assertEquals(rows[0].connection_id, CONN_ACTIVE);
    assertEquals(rows[0].status, "success");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a slug outside the registry allow-list is refused before the connector is called", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ successful: true, data: {} }));
  try {
    const client = stub();
    const res = await handleRequest(
      executeReq({ ...COMPOSIO_BODY, capability: "SLACK_DELETE_WORKSPACE" }),
      () => client,
    );
    assertEquals(res.status, 403);
    assertEquals(await code(res), "connector_tool_not_allowed");
    assertEquals(outbound.calls.length, 0);
    assertEquals(ledgerRows(client)[0].error_code, "connector_tool_not_allowed");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a mutating slug is refused unless the tool's owner enabled writes; a key cannot widen it", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ successful: true, data: {} }));
  try {
    const refused = stub();
    const res = await handleRequest(
      executeReq({ ...COMPOSIO_BODY, capability: "SLACK_SEND_MESSAGE" }),
      () => refused,
    );
    assertEquals(res.status, 403);
    assertEquals(await code(res), "connector_write_not_allowed");
    assertEquals(outbound.calls.length, 0);

    const allowed = stub({
      tools: AI_AGENT_TOOLS.map((t) =>
        t.id === TOOL_COMPOSIO ? { ...t, settings: { allow_writes: true } } : { ...t }
      ),
    });
    const okRes = await handleRequest(
      executeReq({ ...COMPOSIO_BODY, capability: "SLACK_SEND_MESSAGE" }),
      () => allowed,
    );
    assertEquals(okRes.status, 200);
    assertEquals(outbound.calls.length, 1);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a connection that is not active answers connection_inactive, and one in another workspace answers 404", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ successful: true, data: {} }));
  try {
    const inactive = stub({
      tools: AI_AGENT_TOOLS.map((t) =>
        t.id === TOOL_COMPOSIO ? { ...t, connection_id: CONN_REVOKED } : { ...t }
      ),
    });
    const inactiveRes = await handleRequest(executeReq(COMPOSIO_BODY), () => inactive);
    assertEquals(inactiveRes.status, 409);
    assertEquals(await code(inactiveRes), "connection_inactive");

    const foreign = stub({
      tools: AI_AGENT_TOOLS.map((t) =>
        t.id === TOOL_COMPOSIO ? { ...t, connection_id: CONN_OTHER_WS } : { ...t }
      ),
    });
    const foreignRes = await handleRequest(executeReq(COMPOSIO_BODY), () => foreign);
    assertEquals(foreignRes.status, 404);
    assertEquals(await code(foreignRes), "tool_not_found");
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("an unconfigured connector service refuses every Composio execution", async () => {
  const restoreEnv = withEnv({ ...ADAPTER_ENV, COMPOSIO_API_KEY: null });
  const outbound = withFetch(() => json({ successful: true, data: {} }));
  try {
    const client = stub();
    const res = await handleRequest(executeReq(COMPOSIO_BODY), () => client);
    assertEquals(res.status, 503);
    assertEquals(await code(res), "connector_unavailable");
    assertEquals(outbound.calls.length, 0);
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a connector reporting successful:false is a 502 whose body carries no vendor text", async () => {
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() =>
    json({ successful: false, data: null, error: "channel_not_found: #private-leadership" })
  );
  try {
    const client = stub();
    const res = await handleRequest(executeReq(COMPOSIO_BODY), () => client);
    assertEquals(res.status, 502);
    const raw = await res.text();
    assertEquals(JSON.parse(raw).error.code, "tool_execution_failed");
    assert(!raw.includes("private-leadership"), "the connector's message must not pass through");
  } finally {
    outbound.restore();
    restoreEnv();
  }
});

Deno.test("a deterministic refusal never consumes the caller's Idempotency-Key", async () => {
  // A claim taken and then abandoned holds the key `processing` for its whole
  // lease, so the partner's correct next move — retry with the SAME key —
  // answers idempotency_in_progress for five minutes instead of the real
  // reason. Every gate therefore runs BEFORE the claim.
  const restoreEnv = withEnv(ADAPTER_ENV);
  const outbound = withFetch(() => json({ ok: true, data: {} }));
  try {
    const cases: Array<[string, unknown]> = [
      ["unbound account", { ...NATIVE_BODY, social_account_id: ACCT_UNBOUND }],
      ["unknown tool", { ...NATIVE_BODY, tool_id: TOOL_UNKNOWN }],
      ["undefined capability", { ...NATIVE_BODY, capability: "drop_everything" }],
      ["no adapter", { ...NATIVE_BODY, tool_id: TOOL_WEBHOOK }],
      ["slug outside the allow-list", { ...COMPOSIO_BODY, capability: "SLACK_DELETE_WORKSPACE" }],
      ["a write the owner did not enable", { ...COMPOSIO_BODY, capability: "SLACK_SEND_MESSAGE" }],
    ];
    for (const [label, body] of cases) {
      const client = stub();
      const res = await handleRequest(executeReq(body), () => client);
      assert(res.status >= 400, `${label} should refuse`);
      assertEquals(
        client.rpcNames.includes("claim_partner_idempotency"),
        false,
        `${label} consumed the Idempotency-Key`,
      );
    }
  } finally {
    outbound.restore();
    restoreEnv();
  }
});
