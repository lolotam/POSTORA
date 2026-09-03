import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import type { CustomTool } from "./tools.ts";
import {
  attachComposioTools,
  composioToolParameters,
  type ComposioReadyTool,
} from "./composioTools.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";

const NATIVE_TOOL: CustomTool = {
  id: "99999999-9999-4999-8999-999999999999",
  name: "legacy_webhook",
  description: "Existing production connector.",
  url: "https://example.test/hook",
  secret: "legacy-secret",
  admin_only: false,
  connector_type: "custom_rest",
};

const CONNECTION_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function composioTool(overrides: Partial<CustomTool> = {}): CustomTool {
  return {
    ...NATIVE_TOOL,
    id: "11111111-1111-4111-8111-111111111111",
    name: "stock_sheet",
    description: "Our stock sheet.",
    url: "",
    secret: null,
    connector_type: "google_sheets",
    auth_strategy: "composio_oauth",
    connection_id: CONNECTION_ID,
    ...overrides,
  };
}

const SCHEMA_CACHE = [
  {
    slug: "GOOGLESHEETS_BATCH_GET",
    description: "Reads one or more ranges.",
    inputParameters: {
      properties: {
        spreadsheet_id: { type: "string" },
        range: { type: "string" },
      },
      required: ["spreadsheet_id"],
    },
    version: "latest",
  },
  {
    slug: "GOOGLESHEETS_LOOKUP_SPREADSHEET_ROW",
    description: "Looks up a row by value.",
    inputParameters: {
      properties: {
        spreadsheet_id: { type: "string" },
        value: { type: "string" },
      },
      required: [],
    },
    version: "latest",
  },
];

interface ConnectionRow {
  id: string;
  workspace_id: string;
  connector_type: string;
  toolkit: string;
  composio_connected_account_id: string | null;
  tool_schema_cache: unknown;
  status: string;
}

interface FakeAdminState {
  scopedRow?: ConnectionRow | null;
  unscopedHit?: boolean;
  scopedError?: unknown;
  inserts: unknown[];
}

// Mirrors the query shapes loadActiveConnection issues: the scoped read is
// .select(many).eq("id",…).eq("workspace_id",…).maybeSingle(); the second,
// id-only read exists only to name a cross-workspace refusal correctly.
function fakeConnectionAdmin(state: FakeAdminState) {
  let scopedQueries = 0;
  const admin = {
    from(table: string) {
      if (table === "connector_call_logs") {
        return {
          insert: (row: unknown) => {
            state.inserts.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "connector_connections") {
        return {
          select: (_columns: string) => ({
            eq: (_column: string, value: string) => ({
              eq: (_column2: string, _value2: string) => {
                scopedQueries += 1;
                return {
                  maybeSingle: () =>
                    Promise.resolve({
                      data: state.scopedRow ?? null,
                      error: state.scopedError ?? null,
                    }),
                };
              },
              maybeSingle: () =>
                Promise.resolve({
                  data: state.unscopedHit ? { id: value } : null,
                  error: null,
                }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
  return {
    admin,
    scopedQueryCount: () => scopedQueries,
  };
}

function activeConnectionRow(
  overrides: Partial<ConnectionRow> = {},
): ConnectionRow {
  return {
    id: CONNECTION_ID,
    workspace_id: "ws-1",
    connector_type: "google_sheets",
    toolkit: "googlesheets",
    composio_connected_account_id: "composio-account-1",
    tool_schema_cache: SCHEMA_CACHE,
    status: "active",
    ...overrides,
  };
}

const ACCOUNT = { workspaceId: "ws-1", id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" };

// ---------------------------------------------------------------------------
// Spec §7.1: an omission at prompt assembly is a console.warn, NEVER a
// connector_call_logs row. One row per reply per dead connection would swamp
// refused_30d; the ledger records execution attempts only.
// ---------------------------------------------------------------------------

Deno.test("an account without a workspace omits every Composio tool with connection_not_found", async () => {
  const inserts: unknown[] = [];
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({ inserts });

  const result = await attachComposioTools(
    admin,
    [NATIVE_TOOL, composioTool()],
    { workspaceId: null, id: ACCOUNT.id },
    (message) => warns.push(message),
  );

  assertEquals(result.map((tool) => tool.name), ["legacy_webhook"]);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "connection_not_found");
  assertStringIncludes(warns[0], "11111111-1111-4111-8111-111111111111");
  assertEquals(inserts.length, 0, "prompt-assembly omissions must not write ledger rows");
});

Deno.test("an inactive connection omits the tool with connection_inactive", async () => {
  const inserts: unknown[] = [];
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({
    scopedRow: activeConnectionRow({ status: "initiated" }),
    inserts,
  });

  const result = await attachComposioTools(
    admin,
    [composioTool()],
    ACCOUNT,
    (message) => warns.push(message),
  );

  assertEquals(result, []);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "connection_inactive");
  assertEquals(inserts.length, 0);
});

Deno.test("a connection in another workspace omits the tool with tenancy_mismatch", async () => {
  const inserts: unknown[] = [];
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({
    scopedRow: null,
    unscopedHit: true,
    inserts,
  });

  const result = await attachComposioTools(
    admin,
    [composioTool()],
    ACCOUNT,
    (message) => warns.push(message),
  );

  assertEquals(result, []);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "tenancy_mismatch");
  assertEquals(inserts.length, 0);
});

Deno.test("a missing connection omits the tool with connection_not_found", async () => {
  const inserts: unknown[] = [];
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({ scopedRow: null, inserts });

  const result = await attachComposioTools(
    admin,
    [composioTool()],
    ACCOUNT,
    (message) => warns.push(message),
  );

  assertEquals(result, []);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "connection_not_found");
  assertEquals(inserts.length, 0);
});

Deno.test("a Composio tool without a connection_id is omitted, not executed", async () => {
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({ inserts: [] });

  const result = await attachComposioTools(
    admin,
    [composioTool({ connection_id: null })],
    ACCOUNT,
    (message) => warns.push(message),
  );

  assertEquals(result, []);
  assertStringIncludes(warns[0], "connection_not_found");
});

Deno.test("an empty schema cache omits the tool with schema_missing", async () => {
  const inserts: unknown[] = [];
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({
    scopedRow: activeConnectionRow({ tool_schema_cache: null }),
    inserts,
  });

  const result = await attachComposioTools(
    admin,
    [composioTool()],
    ACCOUNT,
    (message) => warns.push(message),
  );

  assertEquals(result, []);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "schema_missing");
  assertEquals(inserts.length, 0);
});

Deno.test("a failed connection read omits the tool and names the failure", async () => {
  const warns: string[] = [];
  const { admin } = fakeConnectionAdmin({
    scopedError: { message: "statement timeout" },
    inserts: [],
  });

  const result = await attachComposioTools(
    admin,
    [composioTool()],
    ACCOUNT,
    (message) => warns.push(message),
  );

  // A discarded error must not look like "no connection": the read failed and
  // the warning says so. The reply itself still proceeds.
  assertEquals(result, []);
  assertEquals(warns.length, 1);
  assertStringIncludes(warns[0], "connection_read_failed");
});

Deno.test("an active cached connection attaches and native tools pass through untouched", async () => {
  const inserts: unknown[] = [];
  const { admin } = fakeConnectionAdmin({
    scopedRow: activeConnectionRow(),
    inserts,
  });

  const result = await attachComposioTools(admin, [NATIVE_TOOL, composioTool()], ACCOUNT);

  assertEquals(result.length, 2);
  assertEquals(result[0], NATIVE_TOOL, "native tools are the same objects, untouched");
  const ready = result[1] as ComposioReadyTool;
  assertEquals(ready.name, "stock_sheet");
  assertEquals(ready.auth_strategy, "composio_oauth");
  assertEquals(ready.connection.id, CONNECTION_ID);
  assertEquals(ready.connection.workspaceId, "ws-1");
  assertEquals(ready.connection.composioConnectedAccountId, "composio-account-1");
  assertEquals(inserts.length, 0, "assembly never writes ledger rows");
});

Deno.test("one connection referenced by two tools is loaded once", async () => {
  const { admin, scopedQueryCount } = fakeConnectionAdmin({
    scopedRow: activeConnectionRow(),
    inserts: [],
  });

  const result = await attachComposioTools(
    admin,
    [composioTool(), composioTool({ id: "22222222-2222-4222-8222-222222222222", name: "price_sheet" })],
    ACCOUNT,
  );

  assertEquals(result.length, 2);
  assertEquals(scopedQueryCount(), 1);
});

Deno.test("with no Composio tools nothing is queried and the array is returned as-is", async () => {
  const { admin, scopedQueryCount } = fakeConnectionAdmin({ inserts: [] });

  const result = await attachComposioTools(admin, [NATIVE_TOOL], ACCOUNT);

  assertEquals(result, [NATIVE_TOOL]);
  assertEquals(scopedQueryCount(), 0);
});

// ---------------------------------------------------------------------------
// composioToolParameters: the flat {capability enum + parameters} contract the
// adapter path already uses. No oneOf — see connectorRouting.test.ts for the
// production outage that cost a real customer their answer.
// ---------------------------------------------------------------------------

function readyTool(cache: unknown = SCHEMA_CACHE): ComposioReadyTool {
  const tool = composioTool() as ComposioReadyTool;
  tool.connection = {
    id: CONNECTION_ID,
    workspaceId: "ws-1",
    connectorType: "google_sheets",
    toolkit: "googlesheets",
    composioConnectedAccountId: "composio-account-1",
    toolSchemaCache: cache as ComposioReadyTool["connection"]["toolSchemaCache"],
  };
  return tool;
}

Deno.test("the capability enum is exactly the registry allow-list", () => {
  const binding = composioBinding("google_sheets")!;
  const parameters = composioToolParameters(readyTool(), binding);

  assertEquals(parameters.type, "object");
  assertEquals(parameters.properties.capability.enum, [...binding.tools]);
  assertEquals(parameters.required, ["capability"]);
  for (const keyword of ["oneOf", "anyOf", "allOf", "enum", "const", "not"]) {
    assertEquals(
      Object.hasOwn(parameters, keyword),
      false,
      `top-level "${keyword}" is refused by OpenAI`,
    );
  }
});

Deno.test("cached input parameters are merged flat under parameters", () => {
  const binding = composioBinding("google_sheets")!;
  const parameters = composioToolParameters(readyTool(), binding);

  assertEquals(parameters.properties.parameters.type, "object");
  const flat = parameters.properties.parameters.properties as Record<string, unknown>;
  assertEquals(Object.hasOwn(flat, "spreadsheet_id"), true);
  assertEquals(Object.hasOwn(flat, "range"), true);
  assertEquals(Object.hasOwn(flat, "value"), true);
});

Deno.test("each slug's arguments are named in the capability description", () => {
  const binding = composioBinding("google_sheets")!;
  const description = composioToolParameters(readyTool(), binding)
    .properties.capability.description;

  assertStringIncludes(description, "GOOGLESHEETS_BATCH_GET");
  assertStringIncludes(description, "spreadsheet_id (required)");
  assertStringIncludes(description, "Reads one or more ranges.");
});

Deno.test("an allow-listed slug without a cached schema still appears in the enum", () => {
  const binding = composioBinding("google_sheets")!;
  const parameters = composioToolParameters(readyTool([]), binding);

  assertEquals(parameters.properties.capability.enum, [...binding.tools]);
  assertEquals(
    (parameters.properties.parameters.properties as Record<string, unknown>).length ?? 0,
    Object.keys(parameters.properties.parameters.properties as Record<string, unknown>).length,
  );
});
