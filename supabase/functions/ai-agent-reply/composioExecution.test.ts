import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { ComposioError } from "../_shared/composioClient.ts";
import type { ConnectorCallRow } from "./connectorExecution.ts";
import { executeComposioTool } from "./composioExecution.ts";
import type { ComposioReadyTool } from "./composioTools.ts";
import type { ToolContext } from "./tools.ts";

const CONNECTION = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  workspaceId: "ws-1",
  connectorType: "google_sheets",
  toolkit: "googlesheets",
  composioConnectedAccountId: "composio-account-1",
  toolSchemaCache: [],
};

const SHEETS_TOOL: ComposioReadyTool = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "stock_sheet",
  description: "Our stock sheet.",
  url: "",
  secret: null,
  admin_only: false,
  connector_type: "google_sheets",
  auth_strategy: "composio_oauth",
  connection_id: CONNECTION.id,
  connection: CONNECTION,
};

const READ_SLUG = "GOOGLESHEETS_BATCH_GET";
const WRITE_SLUG = "GOOGLESHEETS_BATCH_UPDATE";

function context(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    admin: ledgerAdmin({ rows: [] }),
    userId: "33333333-3333-4333-8333-333333333333",
    platform: "whatsapp",
    conversationId: "conversation-1",
    customerName: "Customer",
    adminPhoneNumbers: [],
    dryRun: false,
    socialAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    requestId: "req-1",
    isAdmin: false,
    retrieveKnowledge: () => Promise.resolve([]),
    sendWhatsAppText: () => Promise.resolve(),
    ...overrides,
  } as ToolContext;
}

interface LedgerState {
  rows: unknown[];
  failInsert?: boolean;
}

function ledgerAdmin(state: LedgerState) {
  return {
    from(table: string) {
      if (table === "connector_call_logs") {
        return {
          insert: (row: unknown) => {
            state.rows.push(row);
            return Promise.resolve(
              state.failInsert ? { error: { message: "ledger down" } } : { error: null },
            );
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

interface RecordedExecute {
  slug: string;
  version: string;
  workspaceId: string;
  connectedAccountId: string;
  arguments: Record<string, unknown>;
}

function fakeClient(
  respond: (
    input: RecordedExecute,
    signal: AbortSignal,
  ) => Promise<{ successful: boolean; data?: unknown; error?: string }>,
) {
  const calls: RecordedExecute[] = [];
  return {
    calls,
    executeTool: (input: {
      slug: string;
      version: string;
      workspaceId: string;
      connectedAccountId: string;
      arguments: Record<string, unknown>;
      signal: AbortSignal;
    }) => {
      const { signal, ...recorded } = input;
      calls.push(recorded);
      return respond(recorded, signal);
    },
  };
}

Deno.test("dryRun performs no network call and writes no ledger row", async () => {
  const { rows } = { rows: [] as unknown[] };
  const client = fakeClient(() => {
    throw new Error("client must not be called in dry run");
  });

  const result = await executeComposioTool(
    context({ dryRun: true }),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: { spreadsheet_id: "s1" } },
    { client, admin: ledgerAdmin({ rows }) },
  );

  assertStringIncludes(result.output, "test mode");
  assertStringIncludes(result.output, "stock_sheet");
  assertEquals(client.calls.length, 0);
  assertEquals(rows.length, 0);
});

Deno.test("a slug outside the registry allow-list is refused and logged", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() => Promise.resolve({ successful: true, data: {} }));

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: "GOOGLESHEETS_DELETE_EVERYTHING", parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertEquals(client.calls.length, 0);
  assertStringIncludes(result.output, "not allowed");
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "refused");
  assertEquals(row.error_code, "connector_tool_not_allowed");
  assertEquals(row.action_name, "GOOGLESHEETS_DELETE_EVERYTHING");
});

Deno.test("a mutating slug is refused for a non-admin without allow_writes", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() => Promise.resolve({ successful: true, data: {} }));

  const result = await executeComposioTool(
    context({ isAdmin: false }),
    SHEETS_TOOL,
    { capability: WRITE_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertEquals(client.calls.length, 0);
  assertStringIncludes(result.output, "not allowed");
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "refused");
  assertEquals(row.error_code, "connector_write_not_allowed");
});

Deno.test("an admin may run a mutating slug without allow_writes", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() =>
    Promise.resolve({ successful: true, data: { updated: true } })
  );

  const result = await executeComposioTool(
    context({ isAdmin: true }),
    SHEETS_TOOL,
    { capability: WRITE_SLUG, parameters: { spreadsheet_id: "s1" } },
    { client, admin: ledgerAdmin(state) },
  );

  assertEquals(client.calls.length, 1);
  assertStringIncludes(result.output, "returned");
  assertEquals((state.rows[0] as ConnectorCallRow).status, "success");
});

Deno.test("settings.allow_writes unlocks a mutating slug for a non-admin", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() => Promise.resolve({ successful: true, data: [] }));
  const tool: ComposioReadyTool = { ...SHEETS_TOOL, settings: { allow_writes: true } };

  const result = await executeComposioTool(
    context({ isAdmin: false }),
    tool,
    { capability: WRITE_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertEquals(client.calls.length, 1);
  assertStringIncludes(result.output, "returned");
});

Deno.test("no Composio client is a connector_unavailable refusal", async () => {
  const state = { rows: [] as unknown[] };

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client: null, admin: ledgerAdmin(state), getEnv: () => undefined },
  );

  assertStringIncludes(result.output, "not available");
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "refused");
  assertEquals(row.error_code, "connector_unavailable");
});

Deno.test("success meters the call and caps the model-visible output", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() =>
    Promise.resolve({ successful: true, data: { rows: [["a", 1]] } })
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: { spreadsheet_id: "s1" } },
    { client, admin: ledgerAdmin(state) },
  );

  assertStringIncludes(result.output, 'Connector "stock_sheet" returned: {"rows":[["a",1]]}');
  assertEquals(client.calls[0].slug, READ_SLUG);
  assertEquals(client.calls[0].version, "latest");
  assertEquals(client.calls[0].workspaceId, "ws-1");
  assertEquals(client.calls[0].connectedAccountId, "composio-account-1");
  assertEquals(client.calls[0].arguments, { spreadsheet_id: "s1" });

  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "success");
  assertEquals(row.workspace_id, "ws-1");
  assertEquals(row.tool_id, SHEETS_TOOL.id);
  assertEquals(row.connection_id, CONNECTION.id);
  assertEquals(row.social_account_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assertEquals(row.action_name, READ_SLUG);
  assertEquals(row.source, "agent");
  assertEquals(row.auth_strategy, "composio_oauth");
  assertEquals(row.request_id, "req-1");
  assertEquals(typeof row.latency_ms, "number");
});

Deno.test("an oversized payload is capped at the adapter output limit", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() =>
    Promise.resolve({ successful: true, data: { blob: "x".repeat(20_000) } })
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  // 'Connector "stock_sheet" returned: ' + 8000-char capped JSON.
  assertEquals(result.output.length, 'Connector "stock_sheet" returned: '.length + 8_000);
});

Deno.test("successful:false is a failure with a sanitized, bounded message", async () => {
  const state = { rows: [] as unknown[] };
  const vendorBody = `quota exceeded ${"z".repeat(2_000)}`;
  const client = fakeClient(() =>
    Promise.resolve({ successful: false, error: vendorBody })
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertStringIncludes(result.output, 'Connector "stock_sheet" failed');
  assertEquals(result.output.length <= 'Connector "stock_sheet" failed: '.length + 300, true);
  assertEquals(result.output.includes("z".repeat(400)), false);

  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "failed");
  assertEquals(row.error_code, "tool_execution_failed");
});

Deno.test("a ComposioError body never reaches the model", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient(() =>
    Promise.reject(new ComposioError("composio_rejected", 422))
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertStringIncludes(result.output, 'Connector "stock_sheet" failed (composio_rejected)');
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "failed");
  assertEquals(row.error_code, "composio_rejected");
});

Deno.test("an aborted call is a timeout row and a 'timed out' answer", async () => {
  const state = { rows: [] as unknown[] };
  // The real client maps an aborted fetch to ComposioError("composio_timeout");
  // this fake reproduces that contract.
  const client = fakeClient(() =>
    Promise.reject(new ComposioError("composio_timeout"))
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertStringIncludes(result.output, "timed out");
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "timeout");
  assertEquals(row.error_code, "connector_timeout");
});

Deno.test("a raw abort signal is classified as a timeout too", async () => {
  const state = { rows: [] as unknown[] };
  const client = fakeClient((_input, signal) =>
    new Promise((_resolve, reject) => {
      signal.addEventListener("abort", () =>
        reject(new DOMException("Aborted", "AbortError"))
      );
    })
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state), timeoutMs: 10 },
  );

  assertStringIncludes(result.output, "timed out");
  assertEquals((state.rows[0] as ConnectorCallRow).status, "timeout");
});

Deno.test("the Composio API key is redacted from any output", async () => {
  const state = { rows: [] as unknown[] };
  const apiKey = "cmp_live_must_never_speak";
  const client = fakeClient(() =>
    Promise.resolve({ successful: true, data: { echo: `key=${apiKey}` } })
  );

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    {
      client,
      admin: ledgerAdmin(state),
      getEnv: (name) => name === "COMPOSIO_API_KEY" ? apiKey : undefined,
    },
  );

  assertEquals(result.output.includes(apiKey), false);
  assertStringIncludes(result.output, "[REDACTED]");
});

Deno.test("a failing ledger insert never changes the tool's outcome", async () => {
  const state = { rows: [] as unknown[], failInsert: true };
  const client = fakeClient(() => Promise.resolve({ successful: true, data: { ok: 1 } }));

  const result = await executeComposioTool(
    context(),
    SHEETS_TOOL,
    { capability: READ_SLUG, parameters: {} },
    { client, admin: ledgerAdmin(state) },
  );

  assertStringIncludes(result.output, '"ok":1');
  assertEquals(state.rows.length, 1);
});
