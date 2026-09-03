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

function recordingClient(insertError: { message: string } | null = null) {
  const rows: DbRow[] = [];
  return {
    rows,
    client: {
      from(table: string) {
        assertEquals(table, "connector_call_logs");
        return {
          insert(row: DbRow) {
            rows.push(row);
            return Promise.resolve({ error: insertError });
          },
        };
      },
    },
  };
}

const callMeta: ConnectorCallMeta = {
  workspaceId: "workspace-1",
  toolId: "tool-1",
  connectionId: "connection-1",
  socialAccountId: "account-1",
  partnerKeyId: "key-1",
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
    workspace_id: "workspace-1",
    tool_id: "tool-1",
    connection_id: "connection-1",
    social_account_id: "account-1",
    partner_key_id: "key-1",
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

Deno.test("recordConnectorCall logs an insert error without rejecting", async () => {
  const harness = recordingClient({ message: "secret database detail" });
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

  assertEquals(logged, [["[connector-telemetry] ledger insert failed"]]);
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

Deno.test("withConnectorCall accepts the one-argument DOMException abort shape", async () => {
  const harness = recordingClient();

  await assertRejects(() =>
    withConnectorCall(
      harness.client,
      callMeta,
      () => Promise.reject(new DOMException("AbortError")),
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
