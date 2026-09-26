import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { CONNECTOR_TYPES } from "../_shared/connectorRegistry.ts";
import {
  customToolDefinitions,
  type CustomTool,
  type ToolContext,
} from "./tools.ts";
import {
  executeAdapterTool,
  executeRoutedCustomTool,
  type ConnectorCallRow,
} from "./connectorExecution.ts";
import {
  ADAPTER_CALL_TIMEOUT_MS,
  ADAPTER_OUTPUT_LIMIT,
  POST_TOOL_RESERVE_MS,
  SUPABASE_CALL_TIMEOUT_MS,
  adapterCallBudget,
} from "./connectorExecution.ts";
import {
  SUPABASE_LOOP_BUDGET_MS,
  SUPABASE_MIN_HOP_MS,
} from "../ai-agent-adapters/supabase.ts";
import type { ComposioReadyTool } from "./composioTools.ts";
import type { ComposioExecutionDependencies } from "./composioExecution.ts";

const legacyTool: CustomTool = {
  id: "11111111-1111-4111-8111-111111111111",
  name: "legacy_webhook",
  description: "Existing production connector.",
  url: "https://example.test/hook",
  secret: "legacy-secret",
  admin_only: false,
  connector_type: "custom_rest",
};

const wooTool: CustomTool = {
  ...legacyTool,
  id: "22222222-2222-4222-8222-222222222222",
  name: "woo_store",
  connector_type: "woocommerce",
};

const composioTool: ComposioReadyTool = {
  ...legacyTool,
  id: "55555555-5555-4555-8555-555555555555",
  name: "stock_sheet",
  connector_type: "google_sheets",
  auth_strategy: "composio_oauth",
  connection_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  connection: {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    workspaceId: "ws-1",
    connectorType: "google_sheets",
    toolkit: "googlesheets",
    composioConnectedAccountId: "composio-account-1",
    toolSchemaCache: [],
  },
};

interface LedgerState {
  rows: unknown[];
  accountWorkspaceId?: string | null;
}

// Serves both doors of the routed metering: the ledger insert and the
// resolveWorkspaceForCall account lookup (social_accounts by id and user_id).
function ledgerAdmin(state: LedgerState) {
  return {
    from(table: string) {
      if (table === "connector_call_logs") {
        return {
          insert: (row: unknown) => {
            state.rows.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === "social_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: state.accountWorkspaceId === undefined
                      ? { workspace_id: "ws-agent" }
                      : state.accountWorkspaceId === null
                        ? null
                        : { workspace_id: state.accountWorkspaceId },
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };
}

const context = (dryRun = false): ToolContext => ({
  admin: ledgerAdmin({ rows: [] }),
  userId: "33333333-3333-4333-8333-333333333333",
  platform: "whatsapp",
  conversationId: "conversation-1",
  customerName: "Customer",
  adminPhoneNumbers: [],
  dryRun,
  socialAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  requestId: "req-routing-1",
  isAdmin: false,
  retrieveKnowledge: () => Promise.resolve([]),
  sendWhatsAppText: () => Promise.resolve(),
});

const typedArgs = {
  capability: "search_products",
  parameters: { query: "hat" },
};

Deno.test("custom_rest keeps the byte-identical legacy function schema", () => {
  const actual = JSON.stringify(customToolDefinitions([legacyTool]));
  const expected = JSON.stringify([{
    type: "function",
    function: {
      name: "legacy_webhook",
      description: "Existing production connector.",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The request to send to this connector, in plain language with all needed details",
          },
        },
        required: ["input"],
      },
    },
  }]);

  assertEquals(actual, expected);
});

Deno.test("woocommerce schema makes the model choose a capability with typed parameters", () => {
  const parameters = customToolDefinitions([wooTool])[0].function.parameters;
  const serialized = JSON.stringify(parameters);

  assertStringIncludes(serialized, "search_products");
  assertStringIncludes(serialized, "check_stock");
  assertStringIncludes(serialized, "lookup_orders");
  assertStringIncludes(serialized, "query");
  assertStringIncludes(serialized, "sku");
  assertStringIncludes(serialized, "order_id");
  assertEquals(serialized.includes('"input"'), false);
});

Deno.test("woocommerce routes only to the adapter executor", async () => {
  let adapterCalls = 0;
  let legacyCalls = 0;

  const result = await executeRoutedCustomTool(context(), wooTool, typedArgs, {
    executeAdapter: () => {
      adapterCalls += 1;
      return Promise.resolve({ output: "adapter result" });
    },
    executeLegacy: () => {
      legacyCalls += 1;
      return Promise.resolve({ output: "legacy result" });
    },
  });

  assertEquals(result.output, "adapter result");
  assertEquals(adapterCalls, 1);
  assertEquals(legacyCalls, 0);
});

Deno.test("custom_rest routes only to the legacy executor", async () => {
  let adapterCalls = 0;
  let legacyCalls = 0;

  const result = await executeRoutedCustomTool(context(), legacyTool, { input: "hello" }, {
    executeAdapter: () => {
      adapterCalls += 1;
      return Promise.resolve({ output: "adapter result" });
    },
    executeLegacy: () => {
      legacyCalls += 1;
      return Promise.resolve({ output: "legacy result" });
    },
  });

  assertEquals(result.output, "legacy result");
  assertEquals(adapterCalls, 0);
  assertEquals(legacyCalls, 1);
});

Deno.test("adapter dryRun performs no network call unless the tool is read-only", async () => {
  let fetchCalls = 0;
  const writable = {
    ...legacyTool,
    id: "77777777-7777-4777-8777-777777777777",
    name: "supabase_db",
    connector_type: "supabase",
    read_only_mode: false,
  };
  const result = await executeAdapterTool(context(true), writable, typedArgs, {
    fetch: () => {
      fetchCalls += 1;
      return Promise.reject(new Error("fetch must not run"));
    },
    getEnv: () => "must-not-be-read",
  });

  assertEquals(fetchCalls, 0);
  assertStringIncludes(result.output, "test mode");
});

Deno.test("adapter structured failure is named and is not empty success", async () => {
  const result = await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: () => Promise.resolve(Response.json({
      ok: false,
      vendor: "woocommerce",
      error: {
        code: "woocommerce_http_error",
        message: "WooCommerce rejected the request.",
        vendor_status: 401,
      },
    })),
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
  });

  assertStringIncludes(result.output, 'Connector "woo_store" failed');
  assertStringIncludes(result.output, "woocommerce_http_error");
  assertStringIncludes(result.output, "401");
  assertEquals(result.output.includes("no results"), false);
});

Deno.test("adapter call uses the in-cluster URL and service-role internal contract", async () => {
  const serviceRoleKey = "internal-service-role-key";
  let capturedRequest: Request | undefined;
  await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: (request) => {
      capturedRequest = request as Request;
      return Promise.resolve(Response.json({
        ok: true,
        vendor: "woocommerce",
        action: "execute",
        capability: "search_products",
        data: [],
      }));
    },
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000/" : serviceRoleKey,
  });

  assertEquals(capturedRequest?.url, "http://kong:8000/functions/v1/ai-agent-adapters");
  assertEquals(capturedRequest?.headers.get("authorization"), `Bearer ${serviceRoleKey}`);
  assertEquals(capturedRequest?.headers.get("apikey"), serviceRoleKey);
  assertEquals(await capturedRequest?.json(), {
    tool_id: wooTool.id,
    user_id: context().userId,
    action: "execute",
    capability: "search_products",
    parameters: { query: "hat" },
    // The callee sizes its own work from this. Without it the adapter assumes
    // its full ceiling and plans a loop this caller will abort, discarding
    // every page already fetched. 6000 is WooCommerce's ceiling, unchanged.
    call_budget_ms: ADAPTER_CALL_TIMEOUT_MS,
  });
});

Deno.test("adapter timeout and non-JSON responses degrade to named failures", async (test) => {
  await test.step("timeout", async () => {
    const result = await executeAdapterTool(context(), wooTool, typedArgs, {
      fetch: (input) => new Promise<Response>((_resolve, reject) => {
        (input as Request).signal.addEventListener(
          "abort",
          () => reject(new DOMException("Aborted", "AbortError")),
        );
      }),
      getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
      timeoutMs: 1,
    });

    assertStringIncludes(result.output, 'Connector "woo_store" failed');
    assertStringIncludes(result.output, "timed out");
  });

  await test.step("non-JSON", async () => {
    const result = await executeAdapterTool(context(), wooTool, typedArgs, {
      fetch: () => Promise.resolve(new Response("upstream proxy page", { status: 200 })),
      getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
    });

    assertStringIncludes(result.output, 'Connector "woo_store" failed');
    assertStringIncludes(result.output, "invalid response");
    assertEquals(result.output.includes("upstream proxy page"), false);
  });
});

Deno.test("adapter ToolResult never exposes connector or service-role secrets", async () => {
  const serviceRoleKey = "service-role-super-secret";
  const result = await executeAdapterTool(context(), wooTool, typedArgs, {
    fetch: () => Promise.resolve(Response.json({
      ok: false,
      vendor: "woocommerce",
      error: {
        code: "connector_request_failed",
        message: `${serviceRoleKey} ${wooTool.secret}`,
      },
    })),
    getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : serviceRoleKey,
  });

  assertEquals(result.output.includes(serviceRoleKey), false);
  assertEquals(result.output.includes(wooTool.secret!), false);
});

/**
 * Production regression, 2026-08-31 19:29 UTC (conversation wa_96597950350_*).
 *
 * A customer asked for the most expensive perfume in a live WooCommerce store.
 * The connector was configured, enabled, account-scoped and `last_test_ok`, and
 * the agent still answered "I have no direct information" — it called
 * `search_knowledge` and never the store.
 *
 * Cause: `typedParameters` was `{type:"object", oneOf:[…]}` with NO top-level
 * `properties`. Google's OpenAI-compatible endpoint — the live model for every
 * recent reply — drops `oneOf`, so the model saw a function whose arguments
 * object had no fields at all. Reproduced against
 * generativelanguage.googleapis.com/v1beta/openai/chat/completions with
 * gemini-2.5-flash:
 *
 *   oneOf only          -> woocommerce_store({})
 *   top-level properties-> woocommerce_store({"capability":"search_products",
 *                                             "parameters":{"query":"عطر"}})
 *
 * And `{}` can never succeed: connectorExecution.ts refuses a call whose
 * `capability` is not a string ("the requested capability is missing").
 *
 * The first fix kept `oneOf` alongside the new `properties`, on the theory that
 * providers honouring it would get a more precise contract. That was wrong, and
 * production said so within the hour (2026-08-31 20:57 UTC):
 *
 *   Invalid schema for function 'woocommerce_store': schema must have type
 *   'object' and not have 'oneOf'/'anyOf'/'allOf'/'enum'/'const'/'not' at the
 *   top level.                                      -- openai/gpt-4.1-mini
 *
 * OpenAI is the LAST model in the agent chain, so a Gemini blip fell through to
 * it, the schema was refused, the chain was exhausted, and the customer got the
 * outage message instead of an answer. `oneOf` is gone: the flat `properties`
 * pair is the whole contract, and per-capability arguments are described in the
 * capability enum's own description.
 *
 * Asserting on the serialised blob is what let the original defect ship: every
 * capability name was present, just nowhere the model could reach.
 */
Deno.test("a typed connector's capabilities are reachable without oneOf support", () => {
  const parameters = customToolDefinitions([wooTool])[0].function.parameters as unknown as {
    properties?: Record<string, { type?: string; enum?: string[] }>;
    required?: string[];
    oneOf?: unknown[];
  };

  assertEquals(parameters.properties?.capability?.enum, [
    "search_products",
    "check_stock",
    "lookup_orders",
  ]);
  assertEquals(parameters.properties?.parameters?.type, "object");
  assertEquals(parameters.required, ["capability", "parameters"]);
});

Deno.test("no emitted tool schema carries a keyword OpenAI refuses at the top level", () => {
  // OpenAI validates the function schema itself and names these exactly. The
  // check runs over EVERY connector type the registry declares, not just
  // woocommerce, because the schema is generated from shared code: a second
  // type gaining one of these would fail the same way, on the same fallback
  // model, and again only when the primary model happened to be down.
  const forbidden = ["oneOf", "anyOf", "allOf", "enum", "const", "not"];
  const tools = CONNECTOR_TYPES.map((connector_type, index) => ({
    ...legacyTool,
    id: `0000000${index}-0000-4000-8000-000000000000`,
    name: `tool_${connector_type}`,
    connector_type,
  }));

  for (const definition of customToolDefinitions(tools)) {
    const parameters = definition.function.parameters as unknown as Record<string, unknown>;
    assertEquals(parameters.type, "object", `${definition.function.name} is not an object schema`);
    for (const keyword of forbidden) {
      assertEquals(
        Object.hasOwn(parameters, keyword),
        false,
        `${definition.function.name} has top-level "${keyword}"`,
      );
    }
  }
});

Deno.test("every capability's arguments are nameable in the flat schema", () => {
  // Without this a provider that reads only `properties` can pick
  // capability="check_stock" and then have nowhere to put the SKU.
  const parameters = customToolDefinitions([wooTool])[0].function.parameters as unknown as {
    properties: { parameters: { properties: Record<string, unknown> } };
  };
  const flat = parameters.properties.parameters.properties;

  for (const key of ["query", "sku", "order_id"]) {
    assertEquals(Object.hasOwn(flat, key), true, `flat schema is missing ${key}`);
  }
});

/**
 * Production, 2026-09-01 01:49 and 01:50 UTC. After #100 the model finally
 * called the Supabase connector — twice — and both calls failed:
 *
 *   {"event":"connector_failure","operation":"search_products",
 *    "error_code":"supabase_resource_refused"}
 *   {"event":"connector_failure","operation":"search_products",
 *    "error_code":"supabase_http_error","vendor_status":400}
 *
 * The customer was told "I can't get the live price from the system".
 *
 * Nothing ever told the model which table it may read. The parameter said only
 * "Allowed PostgREST table to query", so it guessed a name, was refused, and
 * the refusal — "The Supabase resource is not allowed." — named no alternative,
 * so it could not self-correct inside its five tool iterations either.
 *
 * The connector row already knows: settings.table_allow_list.
 */
Deno.test("the schema names the tables this connector may actually read", () => {
  const tool = {
    ...legacyTool,
    id: "44444444-4444-4444-8444-444444444444",
    name: "supabase_product_catalog",
    connector_type: "supabase",
    settings: { schema: "public", table_allow_list: "price_table" },
  };
  const parameters = customToolDefinitions([tool])[0].function.parameters as unknown as {
    properties: { parameters: { properties: Record<string, { description?: string }> } };
  };
  const table = parameters.properties.parameters.properties.table;
  assertStringIncludes(table.description ?? "", "price_table");
});

Deno.test("several allowed tables are all named", () => {
  const tool = {
    ...legacyTool,
    id: "55555555-5555-4555-8555-555555555555",
    name: "db",
    connector_type: "supabase",
    settings: { table_allow_list: "price_table, stock_table" },
  };
  const parameters = customToolDefinitions([tool])[0].function.parameters as unknown as {
    properties: { parameters: { properties: Record<string, { description?: string }> } };
  };
  const described = parameters.properties.parameters.properties.table.description ?? "";
  assertStringIncludes(described, "price_table");
  assertStringIncludes(described, "stock_table");
});

Deno.test("a connector with no allow-list keeps the registry wording", () => {
  const tool = {
    ...legacyTool,
    id: "66666666-6666-4666-8666-666666666666",
    name: "db2",
    connector_type: "supabase",
  };
  const parameters = customToolDefinitions([tool])[0].function.parameters as unknown as {
    properties: { parameters: { properties: Record<string, { description?: string }> } };
  };
  assertEquals(
    parameters.properties.parameters.properties.table.description,
    "Allowed PostgREST table to query. Omit to use the connector's first allowed table.",
  );
});

// ---------------------------------------------------------------------------
// Spec §7.2 / D5: every live execution attempt from the agent door writes
// exactly one connector_call_logs row. A simulated sandbox call writes none.
// A read-only adapter call in dry run is the exception: it runs and is metered
// with source "test". The Composio branch meters itself inside
// executeComposioTool — including its refusals — so wrapping it again here
// would double-count every call.
// ---------------------------------------------------------------------------

Deno.test("the adapter branch meters through the context admin", async () => {
  const state: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);

  const result = await executeRoutedCustomTool(
    { ...context(), admin },
    wooTool,
    typedArgs,
    {
      executeAdapter: () =>
        Promise.resolve({ output: 'Connector "woo_store" returned: [{"id":1}]' }),
      executeLegacy: () => Promise.resolve({ output: "legacy result" }),
    },
  );

  assertEquals(state.rows.length, 1);
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.source, "agent");
  assertEquals(row.status, "success");
  assertEquals(row.connector_type, "woocommerce");
  assertEquals(row.auth_strategy, "manual_credentials");
  assertEquals(row.tool_id, wooTool.id);
  assertEquals(row.workspace_id, "ws-agent");
  assertEquals(row.social_account_id, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb");
  assertEquals(row.action_name, "search_products");
  assertEquals(row.request_id, "req-routing-1");
  assertStringIncludes(result.output, "returned");
});

Deno.test("the legacy branch writes exactly one agent ledger row", async () => {
  const state: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);

  await executeRoutedCustomTool(
    { ...context(), admin },
    legacyTool,
    { input: "hello" },
    {
      executeAdapter: () => Promise.resolve({ output: "adapter result" }),
      executeLegacy: () => Promise.resolve({ output: "webhook said hi" }),
    },
  );

  assertEquals(state.rows.length, 1);
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.source, "agent");
  assertEquals(row.status, "success");
  assertEquals(row.connector_type, "custom_rest");
  assertEquals(row.action_name, "input");
});

Deno.test("a failed adapter outcome is metered as failed, not success", async () => {
  const state: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);

  const result = await executeRoutedCustomTool(
    { ...context(), admin },
    wooTool,
    typedArgs,
    {
      executeAdapter: () =>
        Promise.resolve({
          output: 'Connector "woo_store" failed via connector adapter: request timed out.',
        }),
      executeLegacy: () => Promise.resolve({ output: "legacy result" }),
    },
  );

  // The model still sees the executor's own failure output.
  assertStringIncludes(result.output, "timed out");
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.status, "timeout");
});

Deno.test("the composio branch writes exactly one agent ledger row", async () => {
  const state: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);
  const composioLedger: LedgerState = { rows: [] };

  const result = await executeRoutedCustomTool(
    { ...context(), admin },
    composioTool,
    { capability: "GOOGLESHEETS_BATCH_GET", parameters: { spreadsheet_id: "s1" } },
    {
      composio: {
        // Cast because ComposioClient carries private #fields; only the
        // executeTool seam is exercised here (pre-existing stub, type-only fix).
        client: {
          executeTool: () =>
            Promise.resolve({ successful: true, data: { rows: [["a"]] } }),
        } as unknown as ComposioExecutionDependencies["client"],
        admin: ledgerAdmin(composioLedger),
      },
    },
  );

  assertStringIncludes(result.output, "returned");
  // Exactly one row for the whole routed call — the outer wrapper must not
  // add a second one on top of executeComposioTool's own.
  assertEquals(composioLedger.rows.length, 1);
  assertEquals(state.rows.length, 0);
  const row = composioLedger.rows[0] as ConnectorCallRow;
  assertEquals(row.source, "agent");
  assertEquals(row.auth_strategy, "composio_oauth");
  assertEquals(row.connector_type, "google_sheets");
  assertEquals(row.workspace_id, "ws-1");
  assertEquals(row.action_name, "GOOGLESHEETS_BATCH_GET");
});

Deno.test("a simulated dryRun writes no ledger row", async () => {
  const state: LedgerState = { rows: [] };
  const composioLedger: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);
  const dry = context(true);

  // A non-read-only adapter stays on the placeholder path (no env, no fetch).
  const writable = {
    ...legacyTool,
    id: "77777777-7777-4777-8777-777777777777",
    name: "supabase_db",
    connector_type: "supabase",
    read_only_mode: false,
  };
  const adapterResult = await executeRoutedCustomTool({ ...dry, admin }, writable, typedArgs);
  assertStringIncludes(adapterResult.output, "test mode");

  // Legacy branch.
  const legacyResult = await executeRoutedCustomTool(
    { ...dry, admin },
    legacyTool,
    { input: "hello" },
  );
  assertStringIncludes(legacyResult.output, "test mode");

  // Composio branch.
  const composioResult = await executeRoutedCustomTool(
    { ...dry, admin: ledgerAdmin(composioLedger) },
    composioTool,
    { capability: "GOOGLESHEETS_BATCH_GET", parameters: {} },
    {
      composio: {
        client: {
          executeTool: () => {
            throw new Error("client must not be called in dry run");
          },
        } as unknown as ComposioExecutionDependencies["client"],
      },
    },
  );
  assertStringIncludes(composioResult.output, "test mode");

  assertEquals(state.rows.length, 0);
  assertEquals(composioLedger.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Budget plumbing (plan 2026-09-09, revision 3 correction C8): the constants
// are scoped per vendor, so raising Supabase's ceiling cannot change
// WooCommerce's behaviour.
// ---------------------------------------------------------------------------

Deno.test("the caller's ceiling leaves room for the adapter's own loop", () => {
  // An inverted budget aborts the callee mid-loop and throws away rows already
  // fetched, surfacing as "request timed out" with no partial result.
  assertEquals(SUPABASE_CALL_TIMEOUT_MS > SUPABASE_LOOP_BUDGET_MS + SUPABASE_MIN_HOP_MS, true);
});

Deno.test("a tool call never spends the reply turn's allowance", () => {
  // Consuming everything returns rows the model then has no time to speak
  // about, so the customer gets the outage response after a successful read.
  assertEquals(adapterCallBudget("supabase", 40_000), SUPABASE_CALL_TIMEOUT_MS);
  assertEquals(adapterCallBudget("supabase", 14_000) < 14_000, true);
  assertEquals(adapterCallBudget("supabase", POST_TOOL_RESERVE_MS), 0);
  assertEquals(adapterCallBudget("supabase", POST_TOOL_RESERVE_MS - 1), 0);
});

Deno.test("the call budget never exceeds the request's remaining time", () => {
  // The model budget is elapsed, not a fresh per-call allowance, so a tool call
  // late in a conversation must shrink rather than overrun the worker.
  assertEquals(adapterCallBudget("supabase", 40_000), SUPABASE_CALL_TIMEOUT_MS);
  assertEquals(adapterCallBudget("supabase", 18_000), 18_000 - POST_TOOL_RESERVE_MS);
  assertEquals(adapterCallBudget("supabase", 0), 0);
  assertEquals(adapterCallBudget("supabase", -5_000), 0);
});

const writableAdapter: CustomTool = {
  ...legacyTool,
  id: "77777777-7777-4777-8777-777777777777",
  name: "supabase_db",
  connector_type: "supabase",
  read_only_mode: false,
};

Deno.test("a dry-run read-only adapter call reaches the stubbed fetch and is metered as test", async () => {
  const state: LedgerState = { rows: [] };
  let fetchCalls = 0;
  const result = await executeRoutedCustomTool(
    { ...context(true), admin: ledgerAdmin(state) },
    wooTool,
    typedArgs,
    {
      executeAdapter: (adapterContext, tool, args) =>
        executeAdapterTool(adapterContext, tool, args, {
          fetch: () => {
            fetchCalls += 1;
            return Promise.resolve(Response.json({
              ok: true,
              vendor: "woocommerce",
              data: [{ id: 1 }],
            }));
          },
          getEnv: (name) => name === "SUPABASE_URL" ? "http://kong:8000" : "service-key",
        }),
    },
  );

  assertEquals(fetchCalls, 1);
  assertStringIncludes(result.output, "returned");
  assertEquals(state.rows.length, 1);
  const row = state.rows[0] as ConnectorCallRow;
  assertEquals(row.source, "test");
  assertEquals(row.status, "success");
  assertEquals(row.connector_type, "woocommerce");
  assertEquals(row.action_name, "search_products");
});

Deno.test("a dry-run custom_rest call and a non-read-only adapter stay simulated and unmetered", async () => {
  const state: LedgerState = { rows: [] };
  const admin = ledgerAdmin(state);
  let fetchCalls = 0;

  const legacyResult = await executeRoutedCustomTool(
    { ...context(true), admin },
    legacyTool,
    { input: "hello" },
  );
  assertStringIncludes(legacyResult.output, "test mode");

  const writableResult = await executeAdapterTool(context(true), writableAdapter, typedArgs, {
    fetch: () => {
      fetchCalls += 1;
      return Promise.reject(new Error("fetch must not run"));
    },
    getEnv: () => "must-not-be-read",
  });
  assertEquals(fetchCalls, 0);
  assertStringIncludes(writableResult.output, "test mode");
  assertEquals(state.rows.length, 0);
});

Deno.test("WooCommerce keeps its 6s budget and 8000-character output cap", () => {
  // C8: the shared constants keep their current values; only Supabase gets new
  // ones, so a WooCommerce call taking 5.5s keeps working exactly as today.
  assertEquals(ADAPTER_CALL_TIMEOUT_MS, 6_000);
  assertEquals(ADAPTER_OUTPUT_LIMIT, 8_000);
  assertEquals(adapterCallBudget("woocommerce", 40_000), 6_000);
});
