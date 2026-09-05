import {
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ConnectorCallMeta,
  ConnectorRefusal,
  recordConnectorCall,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "./connectorTelemetry.ts";

type DbRow = Record<string, unknown>;

class FakeQuery {
  #filters: Array<[string, unknown]> = [];

  constructor(private readonly rows: DbRow[]) {}

  select(): this {
    return this;
  }

  eq(column: string, value: unknown): this {
    this.#filters.push([column, value]);
    return this;
  }

  maybeSingle(): Promise<{ data: DbRow | null; error: null }> {
    const matching = this.rows.filter((row) =>
      this.#filters.every(([column, value]) => row[column] === value)
    );
    return Promise.resolve({ data: matching[0] ?? null, error: null });
  }
}

function lookupClient(tables: Record<string, DbRow[]>) {
  return {
    from(table: string) {
      return new FakeQuery(tables[table] ?? []);
    },
  };
}

function recordingClient(
  insertError: { message: string } | null = null,
  options: { throwInstead?: boolean } = {},
) {
  const rows: DbRow[] = [];
  return {
    rows,
    client: {
      from(table: string) {
        assertEquals(table, "connector_call_logs");
        return {
          insert(row: DbRow) {
            rows.push(row);
            if (options.throwInstead) {
              return Promise.reject(new Error("network went away mid-insert"));
            }
            return Promise.resolve({ error: insertError });
          },
        };
      },
    },
  };
}

// Real uuids, because every one of these maps to a uuid column. The old
// "tool-1"/"connection-1" placeholders were the reason a caller could put a
// Composio slug in tool_id and still see this suite pass while every
// production insert failed.
const callMeta: ConnectorCallMeta = {
  workspaceId: "11111111-1111-4111-8111-111111111111",
  toolId: "22222222-2222-4222-8222-222222222222",
  connectionId: "33333333-3333-4333-8333-333333333333",
  socialAccountId: "44444444-4444-4444-8444-444444444444",
  partnerKeyId: "55555555-5555-4555-8555-555555555555",
  connectorType: "google_sheets",
  authStrategy: "composio_oauth",
  actionName: "GOOGLESHEETS_BATCH_GET",
  source: "partner",
  requestId: "request-1",
};

Deno.test("resolveWorkspaceForCall prefers the account workspace", async () => {
  const client = lookupClient({
    social_accounts: [{
      id: "account-1",
      user_id: "user-1",
      workspace_id: "workspace-account",
    }],
    workspaces: [{
      id: "workspace-personal",
      owner_id: "user-1",
      is_personal: true,
    }],
  });

  assertEquals(
    await resolveWorkspaceForCall(client, {
      socialAccountId: "account-1",
      userId: "user-1",
    }),
    "workspace-account",
  );
});

Deno.test("resolveWorkspaceForCall falls back when the account workspace is null", async () => {
  const client = lookupClient({
    social_accounts: [{
      id: "account-1",
      user_id: "user-1",
      workspace_id: null,
    }],
    workspaces: [{
      id: "workspace-personal",
      owner_id: "user-1",
      is_personal: true,
    }],
  });

  assertEquals(
    await resolveWorkspaceForCall(client, {
      socialAccountId: "account-1",
      userId: "user-1",
    }),
    "workspace-personal",
  );
});

Deno.test("resolveWorkspaceForCall uses the personal workspace without an account", async () => {
  const client = lookupClient({
    workspaces: [{
      id: "workspace-personal",
      owner_id: "user-1",
      is_personal: true,
    }],
  });

  assertEquals(
    await resolveWorkspaceForCall(client, { userId: "user-1" }),
    "workspace-personal",
  );
});

Deno.test("resolveWorkspaceForCall refuses an owner without a workspace", async () => {
  const client = lookupClient({ social_accounts: [], workspaces: [] });

  await assertRejects(
    () =>
      resolveWorkspaceForCall(client, {
        socialAccountId: "missing",
        userId: "user-1",
      }),
    Error,
    "workspace_unresolved",
  );
});

Deno.test("recordConnectorCall maps the ledger row and clamps negative latency", async () => {
  const harness = recordingClient();

  await recordConnectorCall(harness.client, callMeta, {
    status: "failed",
    errorCode: "vendor_failure",
    latencyMs: -4.8,
  });

  assertEquals(harness.rows, [{
    workspace_id: "11111111-1111-4111-8111-111111111111",
    tool_id: "22222222-2222-4222-8222-222222222222",
    connection_id: "33333333-3333-4333-8333-333333333333",
    social_account_id: "44444444-4444-4444-8444-444444444444",
    partner_key_id: "55555555-5555-4555-8555-555555555555",
    connector_type: "google_sheets",
    auth_strategy: "composio_oauth",
    action_name: "GOOGLESHEETS_BATCH_GET",
    source: "partner",
    status: "failed",
    error_code: "vendor_failure",
    request_id: "request-1",
    latency_ms: 0,
  }]);
});

// A caller that hands a uuid column something else loses that one field, with a
// named warning -- not the whole row. The YouTube comment poll put the Composio
// slug in toolId and lost every insert to `invalid input syntax for type uuid`.
Deno.test("ledger row drops a non-uuid id field and still records the call", async () => {
  const harness = recordingClient();
  const originalWarn = console.warn;
  const warned: string[] = [];
  console.warn = (...args: unknown[]) => warned.push(String(args[0]));

  try {
    await recordConnectorCall(
      harness.client,
      { ...callMeta, toolId: "YOUTUBE_LIST_COMMENT_THREADS" },
      { status: "success", latencyMs: 3 },
    );
  } finally {
    console.warn = originalWarn;
  }

  assertEquals(harness.rows.length, 1);
  assertEquals(harness.rows[0].tool_id, null);
  // The rest of the row survives -- that is the whole point.
  assertEquals(harness.rows[0].action_name, "GOOGLESHEETS_BATCH_GET");
  assertEquals(harness.rows[0].connection_id, "33333333-3333-4333-8333-333333333333");
  assertEquals(warned.length, 1);
  assertEquals(warned[0].includes("dropped non-uuid tool_id"), true);
  assertEquals(warned[0].includes("YOUTUBE_LIST_COMMENT_THREADS"), true);
});

// The bare "[connector-telemetry] ledger insert failed" this replaces fired
// every few minutes for a day before anyone noticed (2026-09-03): a failed
// insert must name the reason, the action and the connector.
Deno.test("recordConnectorCall logs an insert error's reason, action and connector without rejecting", async () => {
  const harness = recordingClient({ message: "invalid input syntax for type uuid" });
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    await recordConnectorCall(harness.client, callMeta, {
      status: "success",
      latencyMs: 4,
    });
  } finally {
    console.error = originalError;
  }

  assertEquals(logged.length, 1);
  const message = String(logged[0][0]);
  assertEquals(message.includes("[connector-telemetry] ledger insert failed"), true);
  assertEquals(message.includes("connector=google_sheets"), true);
  assertEquals(message.includes("action=GOOGLESHEETS_BATCH_GET"), true);
  assertEquals(message.includes("invalid input syntax for type uuid"), true);
});

Deno.test("recordConnectorCall logs the reason when the insert itself throws", async () => {
  const harness = recordingClient(null, { throwInstead: true });
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => logged.push(args);

  try {
    await recordConnectorCall(harness.client, callMeta, {
      status: "success",
      latencyMs: 4,
    });
  } finally {
    console.error = originalError;
  }

  assertEquals(logged.length, 1);
  const message = String(logged[0][0]);
  assertEquals(message.includes("action=GOOGLESHEETS_BATCH_GET"), true);
  assertEquals(message.includes("network went away mid-insert"), true);
});

Deno.test("withConnectorCall records success and elapsed latency", async () => {
  const harness = recordingClient();
  const times = [100, 142];

  const value = await withConnectorCall(
    harness.client,
    callMeta,
    () => Promise.resolve("done"),
    { timeoutMs: 1_000, now: () => times.shift()! },
  );

  assertEquals(value, "done");
  assertEquals(harness.rows[0].status, "success");
  assertEquals(harness.rows[0].latency_ms, 42);
});

Deno.test("withConnectorCall records and rethrows a connector refusal", async () => {
  const harness = recordingClient();
  const refusal = new ConnectorRefusal("connector_tool_not_allowed");

  const thrown = await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(refusal),
      { timeoutMs: 1_000, now: () => 10 },
    )
  );

  assertEquals(thrown, refusal);
  assertEquals(harness.rows[0].status, "refused");
  assertEquals(harness.rows[0].error_code, "connector_tool_not_allowed");
});

Deno.test("withConnectorCall records an AbortError as a timeout", async () => {
  const harness = recordingClient();

  await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(new DOMException("timed out", "AbortError")),
      { timeoutMs: 1_000, now: () => 10 },
    )
  );

  assertEquals(harness.rows[0].status, "timeout");
  assertEquals(harness.rows[0].error_code, "connector_timeout");
});

Deno.test("withConnectorCall records an AbortSignal.timeout TimeoutError as a timeout", async () => {
  const harness = recordingClient();

  await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(new DOMException("signal timed out", "TimeoutError")),
      { timeoutMs: 1_000, now: () => 10 },
    )
  );

  assertEquals(harness.rows[0].status, "timeout");
});

Deno.test("withConnectorCall records other coded failures and rethrows", async () => {
  const harness = recordingClient();
  const failure = Object.assign(new Error("vendor response"), {
    code: "composio_rejected",
  });

  const thrown = await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(failure),
      { timeoutMs: 1_000, now: () => 10 },
    )
  );

  assertEquals(thrown, failure);
  assertEquals(harness.rows[0].status, "failed");
  assertEquals(harness.rows[0].error_code, "composio_rejected");
});

Deno.test("withConnectorCall gives uncoded failures a stable ledger code", async () => {
  const harness = recordingClient();

  await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(new Error("unexpected")),
      { timeoutMs: 1_000, now: () => 10 },
    )
  );

  assertEquals(harness.rows[0].status, "failed");
  assertEquals(harness.rows[0].error_code, "connector_failure");
});
