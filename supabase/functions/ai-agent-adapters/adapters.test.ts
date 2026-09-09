import {
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { executeConnector } from "./dispatcher.ts";
import {
  DEFAULT_MAX_ROWS,
  SUPABASE_CHAR_BUDGET,
  SupabaseReadEnvelope,
  resolveColumns,
  resolveMaxRows,
  resolveOffset,
  resolveOrderBy,
  resolvePageSize,
  SupabaseValidationError,
} from "./supabase.ts";
import { handleAdapterRequest, meterTestConnectionProbe, type AdminClientFactory } from "./handler.ts";
import {
  type AdapterDependencies,
  type ConnectorResult,
  type ConnectorTool,
  type ExecuteConnectorRequest,
} from "./types.ts";

const WOO_KEY = "ck_customer_dm_must_never_speak_this";
const WOO_SECRET = "cs_customer_dm_must_never_speak_this";
const SUPABASE_ANON_KEY = makeJwt({ role: "anon" });
const SUPABASE_SERVICE_KEY = makeJwt({ role: "service_role" });

function makeJwt(payload: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode(payload)}.signature`;
}

function wooTool(overrides: Partial<ConnectorTool> = {}): ConnectorTool {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    connector_type: "woocommerce",
    settings: { store_url: "https://store.example.com" },
    permissions: { search_products: true, check_stock: true, lookup_orders: true },
    read_only_mode: true,
    ...overrides,
  };
}

function supabaseTool(overrides: Partial<ConnectorTool> = {}): ConnectorTool {
  return {
    id: "00000000-0000-0000-0000-000000000002",
    connector_type: "supabase",
    settings: {
      project_url: "https://project.example.com",
      schema: "public",
      table_allow_list: ["products", "orders"],
    },
    permissions: { search_products: true, check_stock: true, lookup_orders: true },
    read_only_mode: true,
    ...overrides,
  };
}

function request(
  overrides: Partial<ExecuteConnectorRequest> = {},
): ExecuteConnectorRequest {
  return {
    action: "execute",
    capability: "search_products",
    parameters: { query: "hat" },
    ...overrides,
  };
}

function dependencies(
  fetchImpl: typeof fetch,
  checkedUrls: string[] = [],
  logged: unknown[] = [],
): AdapterDependencies {
  return {
    fetch: fetchImpl,
    timeoutMs: 1_000,
    maxRedirects: 3,
    assertPublicHttpsUrl: (rawUrl: string) => {
      checkedUrls.push(rawUrl);
      return Promise.resolve(new URL(rawUrl));
    },
    log: (event) => logged.push(event),
  };
}

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

function serialized(value: unknown): string {
  return JSON.stringify(value);
}

Deno.test("WooCommerce builds HTTP Basic auth from consumer key and secret", async () => {
  let authorization = "";
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies((_url, init) => {
      authorization = new Headers(init?.headers).get("Authorization") ?? "";
      return Promise.resolve(jsonResponse([]));
    }),
  );

  assertEquals(result.ok, true);
  assertEquals(authorization, `Basic ${btoa(`${WOO_KEY}:${WOO_SECRET}`)}`);
});

Deno.test("WooCommerce 401 is a named failure, never empty data or vendor text", async () => {
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(
      jsonResponse({ message: `bad ${WOO_KEY}:${WOO_SECRET}` }, 401),
    )),
  );

  assertEquals(result, {
    ok: false,
    vendor: "woocommerce",
    error: {
      code: "woocommerce_http_error",
      message: "WooCommerce rejected the request.",
      vendor_status: 401,
    },
  });
  assertEquals(serialized(result).includes(WOO_KEY), false);
  assertEquals(serialized(result).includes(WOO_SECRET), false);
});

Deno.test("read_only_mode refuses a write before fetch is attempted", async () => {
  let fetchCalls = 0;
  const writeAttempt = {
    ...request({ capability: "lookup_orders" }),
    method: "POST",
  } satisfies ExecuteConnectorRequest;

  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: writeAttempt,
    },
    dependencies(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({}));
    }),
  );

  assertEquals(fetchCalls, 0);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "read_only_violation");
    assertStringIncludes(result.error.message, "POST");
  }
});

Deno.test("every redirect hop is passed through the shared SSRF validator", async () => {
  const checkedUrls: string[] = [];
  let fetchCalls = 0;
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies((url) => {
      fetchCalls += 1;
      if (fetchCalls === 1) {
        return Promise.resolve(new Response(null, {
          status: 302,
          headers: { Location: "/wp-json/wc/v3/products?page=2" },
        }));
      }
      assertStringIncludes(String(url), "page=2");
      return Promise.resolve(jsonResponse([]));
    }, checkedUrls),
  );

  assertEquals(result.ok, true);
  assertEquals(fetchCalls, 2);
  assertEquals(checkedUrls.length, 2);
  assertStringIncludes(checkedUrls[0], "store.example.com");
  assertStringIncludes(checkedUrls[1], "store.example.com");
});

Deno.test("Supabase refuses a service-role-shaped key before fetch", async () => {
  let fetchCalls = 0;
  const result = await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_SERVICE_KEY },
      request: request({ parameters: { table: "products", select: "*" } }),
    },
    dependencies(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse([]));
    }),
  );

  assertEquals(fetchCalls, 0);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "supabase_service_role_refused");
  assertEquals(serialized(result).includes(SUPABASE_SERVICE_KEY), false);
});

for (const [name, parameters, expectedCode] of [
  ["RPC path", { table: "/rpc/private_fn", select: "*" }, "supabase_rpc_refused"],
  ["resource embedding", { table: "products", select: "*,orders(*)" }, "supabase_embedding_refused"],
] as const) {
  Deno.test(`Supabase refuses ${name} before fetch`, async () => {
    let fetchCalls = 0;
    const result = await executeConnector(
      {
        tool: supabaseTool(),
        credentials: { anon_key: SUPABASE_ANON_KEY },
        request: request({ parameters }),
      },
      dependencies(() => {
        fetchCalls += 1;
        return Promise.resolve(jsonResponse([]));
      }),
    );

    assertEquals(fetchCalls, 0);
    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.code, expectedCode);
  });
}

Deno.test("Supabase PostgREST error body is a named failure, including on HTTP 200", async () => {
  const result = await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", select: "*" } }),
    },
    dependencies(() => Promise.resolve(
      jsonResponse({ code: "PGRST000", message: `echo ${SUPABASE_ANON_KEY}` }),
    )),
  );

  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "supabase_postgrest_error");
  assertEquals(serialized(result).includes(SUPABASE_ANON_KEY), false);
});

Deno.test("reachable thrown and logged failures redact every credential", async () => {
  const logged: unknown[] = [];
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(
      () => Promise.reject(new Error(`network copied ${WOO_KEY} ${WOO_SECRET}`)),
      [],
      logged,
    ),
  );

  const allOutput = serialized({ result, logged });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "connector_request_failed");
  assertEquals(allOutput.includes(WOO_KEY), false);
  assertEquals(allOutput.includes(WOO_SECRET), false);
});

Deno.test("successful vendor data cannot echo raw or derived credentials", async () => {
  const basicHeader = `Basic ${btoa(`${WOO_KEY}:${WOO_SECRET}`)}`;
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(jsonResponse([{
      note: `echo ${WOO_KEY} and ${WOO_SECRET}`,
      request_headers: { Authorization: basicHeader },
    }]))),
  );

  const output = serialized(result);
  assertEquals(result.ok, true);
  assertEquals(output.includes(WOO_KEY), false);
  assertEquals(output.includes(WOO_SECRET), false);
  assertEquals(output.includes(basicHeader), false);
});

Deno.test("non-JSON vendor rejection keeps its status and never exposes its body", async () => {
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ action: "test_connection", capability: undefined, parameters: {} }),
    },
    dependencies(() => Promise.resolve(new Response(
      `proxy copied ${WOO_SECRET}`,
      { status: 401, headers: { "Content-Type": "text/html" } },
    ))),
  );

  assertEquals(result, {
    ok: false,
    vendor: "woocommerce",
    error: {
      code: "woocommerce_http_error",
      message: "WooCommerce rejected the request.",
      vendor_status: 401,
    },
  });
  assertEquals(serialized(result).includes(WOO_SECRET), false);
});

Deno.test("test_connection success returns capability facts and no credential", async () => {
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ action: "test_connection", capability: undefined, parameters: {} }),
    },
    dependencies(() => Promise.resolve(jsonResponse([]))),
  );

  assertEquals(result, {
    ok: true,
    vendor: "woocommerce",
    action: "test_connection",
    capabilities: ["search_products", "check_stock", "lookup_orders"],
    read_only: true,
  });
  assertEquals(serialized(result).includes(WOO_KEY), false);
  assertEquals(serialized(result).includes(WOO_SECRET), false);
});

Deno.test("test_connection failure returns vendor status and safe credential-free message", async () => {
  const result = await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ action: "test_connection", capability: undefined, parameters: {} }),
    },
    dependencies(() => Promise.resolve(
      jsonResponse({ message: `bad ${SUPABASE_ANON_KEY}` }, 403),
    )),
  );

  assertEquals(result, {
    ok: false,
    vendor: "supabase",
    error: {
      code: "supabase_http_error",
      message: "Supabase rejected the request.",
      vendor_status: 403,
    },
  });
  assertEquals(serialized(result).includes(SUPABASE_ANON_KEY), false);
});

Deno.test("a disabled connector is refused before any vendor call", async () => {
  // Codex P2. The agent prompt happens to exclude disabled tools, so this
  // endpoint looked safe -- but it is reachable on its own, and without the
  // check, turning a connector off in the UI kept sending its credentials to
  // the vendor. A side effect of another component's filter is not a
  // permission boundary.
  // A real spy, not a flag nobody sets: the guard must return before anything
  // reaches the network, and this is what proves it.
  const realFetch = globalThis.fetch;
  let fetched = false;
  globalThis.fetch = ((...args: Parameters<typeof fetch>) => {
    fetched = true;
    return realFetch(...args);
  }) as typeof fetch;
  const previousUrl = Deno.env.get("SUPABASE_URL");
  const previousKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  Deno.env.set("SUPABASE_URL", "https://example.test");
  Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", "service-key");

  const adminStub = () => ({
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: {
                  id: "tool-1",
                  connector_type: "woocommerce",
                  settings: {},
                  permissions: {},
                  read_only_mode: true,
                  is_enabled: false,
                },
                error: null,
              }),
          }),
        }),
      }),
    }),
  });

  const response = await handleAdapterRequest(
    new Request("https://edge.test/ai-agent-adapters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
      body: JSON.stringify({ tool_id: "tool-1", action: "test_connection" }),
    }),
    adminStub as unknown as AdminClientFactory,
  );

  if (previousUrl === undefined) Deno.env.delete("SUPABASE_URL");
  else Deno.env.set("SUPABASE_URL", previousUrl);
  if (previousKey === undefined) Deno.env.delete("SUPABASE_SERVICE_ROLE_KEY");
  else Deno.env.set("SUPABASE_SERVICE_ROLE_KEY", previousKey);

  globalThis.fetch = realFetch;
  assertEquals(fetched, false);
  assertEquals([401, 409].includes(response.status), true);
});

// ---------------------------------------------------------------------------
// Answering a superlative: sorting, category filtering, and a payload that
// survives the model's output budget.
//
// A customer asked a connected store for its most expensive perfume
// (2026-08-31) and got "I have no direct information". search_products was a
// bare `?search=&per_page=20` -- no ordering, so "most expensive" was not
// expressible -- and the raw vendor payload was truncated at 2000 characters
// by connectorExecution.ts, which is less than one WooCommerce product.
// ---------------------------------------------------------------------------

function wooUrlFor(parameters: Record<string, unknown>, pages: unknown[] = [[]]): Promise<string[]> {
  const seen: string[] = [];
  const queue = [...pages];
  return executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ parameters }),
    },
    dependencies((url) => {
      seen.push(String(url));
      return Promise.resolve(jsonResponse(queue.shift() ?? []));
    }),
  ).then(() => seen);
}

Deno.test("sort_by=price asks WooCommerce for the most expensive first", async () => {
  const [url] = await wooUrlFor({ query: "عطر", sort_by: "price" });
  assertStringIncludes(url, "orderby=price");
  assertStringIncludes(url, "order=desc");
});

Deno.test("order=asc is honoured, so the cheapest is answerable too", async () => {
  const [url] = await wooUrlFor({ query: "عطر", sort_by: "price", order: "asc" });
  assertStringIncludes(url, "order=asc");
});

Deno.test("an unrecognised sort word is dropped, never forwarded to the store", async () => {
  // The model supplies this value; it must not reach the query string unchecked.
  const [url] = await wooUrlFor({ query: "عطر", sort_by: "price); DROP" });
  assertEquals(url.includes("orderby="), false);
  assertEquals(url.includes("DROP"), false);
});

Deno.test("the catalogue can be browsed with no search phrase", async () => {
  // "The most expensive product in the store" names no product to search for.
  const [url] = await wooUrlFor({ sort_by: "price" });
  assertEquals(url.includes("search="), false);
  assertStringIncludes(url, "orderby=price");
});

Deno.test("limit defaults to five and is clamped, so results are not truncated away", async () => {
  const [defaulted] = await wooUrlFor({ query: "عطر" });
  assertStringIncludes(defaulted, "per_page=5");
  const [clamped] = await wooUrlFor({ query: "عطر", limit: "500" });
  assertStringIncludes(clamped, "per_page=20");
  const [chosen] = await wooUrlFor({ query: "عطر", limit: "3" });
  assertStringIncludes(chosen, "per_page=3");
});

Deno.test("a named category is resolved to its id before the product search", async () => {
  const urls = await wooUrlFor(
    { query: "عطر", category: "Men's perfumes" },
    [[{ id: 77, name: "Men's perfumes" }], []],
  );
  assertStringIncludes(urls[0], "/products/categories?search=Men");
  assertStringIncludes(urls[1], "category=77");
});

Deno.test("an exact category name beats WooCommerce's first substring hit", async () => {
  const urls = await wooUrlFor(
    { query: "عطر", category: "Perfume" },
    [[{ id: 12, name: "Perfume Samples" }, { id: 34, name: "Perfume" }], []],
  );
  assertStringIncludes(urls[1], "category=34");
});

Deno.test("an unknown category is a named failure, not a silent whole-store search", async () => {
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ parameters: { query: "عطر", category: "Nonexistent" } }),
    },
    dependencies(() => Promise.resolve(jsonResponse([]))),
  );

  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.error.code, "woocommerce_category_not_found");
});

Deno.test("a product is trimmed to the fields an answer is built from", async () => {
  const bulky = {
    id: 9,
    name: "Zimaya Grandeur",
    sku: "ZG-1",
    price: "45.00",
    regular_price: "50.00",
    sale_price: "45.00",
    on_sale: true,
    stock_status: "instock",
    stock_quantity: 4,
    permalink: "https://store.example.com/p/9",
    categories: [{ id: 3, name: "Perfume", slug: "perfume" }],
    description: "x".repeat(6000),
    images: Array.from({ length: 12 }, (_, i) => ({ id: i, src: "https://img.example.com/a.jpg" })),
    meta_data: Array.from({ length: 40 }, (_, i) => ({ id: i, key: `k${i}`, value: "v" })),
  };

  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(jsonResponse([bulky, bulky, bulky, bulky, bulky]))),
  );

  assertEquals(result.ok, true);
  const body = serialized(result.ok === true && result.action === "execute" ? result.data : null);
  assertEquals(body.includes("meta_data"), false);
  assertEquals(body.includes("xxxxx"), false);
  assertStringIncludes(body, "Zimaya Grandeur");
  assertStringIncludes(body, '"price":"45.00"');
  assertStringIncludes(body, '"categories":["Perfume"]');
  // Five products must fit the 2000-character budget connectorExecution.ts
  // applies, or the model reads a fraction of one of them.
  assertEquals(body.length < 2000, true, `projected payload is ${body.length} chars`);
});

Deno.test("an unrecognised payload shape is passed through, not emptied", () => {
  // An empty projection would read to the model as "the store has no results".
  return executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(jsonResponse(["a plain string", 7]))),
  ).then((result) => {
    assertEquals(result.ok, true);
    assertEquals(serialized(result.ok === true && result.action === "execute" ? result.data : null), '["a plain string",7]');
  });
});

/**
 * Production, 2026-09-01. A Supabase price table answers correctly through the
 * adapter, but its rows carry signed storage URLs several hundred characters
 * long. Unlike WooCommerce the table is arbitrary, so the fields cannot be
 * projected; the row count and the per-value length are what can be bounded.
 * Rewritten for the read envelope: rows now live in `data.rows`, and the
 * default limit=25 single request is asserted by the "unconfigured connector"
 * test in the full-table-reads section below.
 */
Deno.test("an oversized cell is truncated so the rest of the rows survive", async () => {
  const signedUrl = `https://p.supabase.co/storage/v1/object/sign/x.png?token=${"e".repeat(600)}`;
  const tableRows = Array.from({ length: 25 }, (_, i) => ({
    id: `row-${i}`,
    type_name: "كتاكيت جميزة",
    price: "١٨ جنية",
    description: "لحم طبيعي وتحويل عالي",
    image_url: signedUrl,
  }));

  const result = await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ capability: "search_products", parameters: { table: "products" } }),
    },
    dependencies(() => Promise.resolve(jsonResponse(tableRows))),
  );

  assertEquals(result.ok, true);
  const data = envelopeOf(result);
  assertEquals(data.row_count, 25);
  // Every row's price must still be there -- that is the answer the customer asked for.
  assertEquals((serialized(data.rows).match(/١٨ جنية/g) || []).length, 25);
  assertEquals(serialized(data.rows).includes("e".repeat(600)), false);
  for (const row of data.rows) {
    const cell = (row as { image_url: string }).image_url;
    // The marker is the point: a silently shortened URL reads as a working link.
    assertEquals(cell.endsWith("…[truncated]"), true);
    assertEquals(cell.length <= 160 + "…[truncated]".length, true);
  }
});

Deno.test("ordinary values are returned untouched", async () => {
  // Truncation must be invisible to a normal row, or it becomes a second bug.
  const result = await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ capability: "search_products", parameters: { table: "products" } }),
    },
    dependencies(() =>
      Promise.resolve(jsonResponse([{ id: 1, price: "١٨ جنية", in_stock: true, qty: 40 }]))
    ),
  );
  assertEquals(result.ok, true);
  assertEquals(
    envelopeOf(result).rows,
    [{ id: 1, price: "١٨ جنية", in_stock: true, qty: 40 }],
  );
});

/**
 * Operator-configured column list (2026-09-01, owner request): the Supabase
 * card can name which columns the agent reads, so a wide table does not spend
 * tokens on ids, timestamps and signed URLs that answer nothing.
 */
Deno.test("configured columns drive the select", async () => {
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: "price_table",
          select_columns: "type_name, price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ capability: "search_products", parameters: { table: "price_table" } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "select=type_name%2Cprice");
});

Deno.test("configured columns override the model's own select", async () => {
  // The setting means "the agent reads ONLY these" — and the model has a record
  // of inventing column names that 400 the whole query.
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: "price_table",
          select_columns: "type_name,price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({
        capability: "search_products",
        parameters: { table: "price_table", select: "product_name,secret_notes" },
      }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "select=type_name%2Cprice");
  assertEquals(requested.includes("secret_notes"), false);
});

Deno.test("without the setting the model's select still works as before", async () => {
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({
        capability: "search_products",
        parameters: { table: "products", select: "name,price" },
      }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "select=name%2Cprice");
});

// ---------------------------------------------------------------------------
// Spec §7.2: the adapter meters ONLY the test_connection probe
// (source='test'); native execute calls are metered by the reply's
// executeRoutedCustomTool, never twice. The probe's own outcome is the answer
// the user sees — a failing ledger insert must not repaint it.
// ---------------------------------------------------------------------------

interface ProbeLedgerState {
  rows: unknown[];
  accountWorkspaceId: string | null;
  personalWorkspaceId: string | null;
  failInsert?: boolean;
}

function probeLedgerAdmin(state: ProbeLedgerState) {
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
      if (table === "social_accounts") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: state.accountWorkspaceId
                      ? { workspace_id: state.accountWorkspaceId }
                      : null,
                    error: null,
                  }),
              }),
            }),
          }),
        };
      }
      if (table === "workspaces") {
        return {
          select: () => ({
            eq: () => ({
              eq: () => ({
                maybeSingle: () =>
                  Promise.resolve({
                    data: state.personalWorkspaceId ? { id: state.personalWorkspaceId } : null,
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

const PROBE_INPUT = {
  userId: "33333333-3333-4333-8333-333333333333",
  toolId: "00000000-0000-0000-0000-000000000009",
  connectorType: "woocommerce",
  socialAccountId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
};

const PROBE_SUCCESS: ConnectorResult = {
  ok: true,
  vendor: "woocommerce",
  action: "test_connection",
  capabilities: ["search_products", "check_stock", "lookup_orders"],
  read_only: true,
};

const PROBE_FAILURE: ConnectorResult = {
  ok: false,
  vendor: "woocommerce",
  error: { code: "woocommerce_http_error", message: "WooCommerce rejected the request.", vendor_status: 401 },
};

Deno.test("a successful probe writes exactly one source='test' ledger row", async () => {
  const state: ProbeLedgerState = {
    rows: [],
    accountWorkspaceId: "ws-probe",
    personalWorkspaceId: null,
  };

  const outcome = await meterTestConnectionProbe(
    probeLedgerAdmin(state),
    PROBE_INPUT,
    () => Promise.resolve(PROBE_SUCCESS),
  );

  assertEquals(outcome, PROBE_SUCCESS);
  assertEquals(state.rows.length, 1);
  assertEquals(state.rows[0], {
    workspace_id: "ws-probe",
    tool_id: PROBE_INPUT.toolId,
    connection_id: null,
    social_account_id: PROBE_INPUT.socialAccountId,
    partner_key_id: null,
    connector_type: "woocommerce",
    auth_strategy: "manual_credentials",
    action_name: "test_connection",
    source: "test",
    status: "success",
    error_code: null,
    request_id: null,
    latency_ms: (state.rows[0] as { latency_ms: number }).latency_ms,
  });
});

Deno.test("a failed probe is metered as failed with its vendor error code", async () => {
  const state: ProbeLedgerState = {
    rows: [],
    accountWorkspaceId: null,
    personalWorkspaceId: "ws-personal",
  };

  const outcome = await meterTestConnectionProbe(
    probeLedgerAdmin(state),
    PROBE_INPUT,
    () => Promise.resolve(PROBE_FAILURE),
  );

  assertEquals(outcome, PROBE_FAILURE);
  const row = state.rows[0] as Record<string, unknown>;
  assertEquals(row.status, "failed");
  assertEquals(row.error_code, "woocommerce_http_error");
  assertEquals(row.workspace_id, "ws-personal");
});

Deno.test("a failing ledger insert does not change the probe outcome", async () => {
  const state: ProbeLedgerState = {
    rows: [],
    accountWorkspaceId: "ws-probe",
    personalWorkspaceId: null,
    failInsert: true,
  };

  const outcome = await meterTestConnectionProbe(
    probeLedgerAdmin(state),
    PROBE_INPUT,
    () => Promise.resolve(PROBE_SUCCESS),
  );

  assertEquals(outcome, PROBE_SUCCESS);
});

Deno.test("an unresolvable workspace still runs the probe, unmetered", async () => {
  const state: ProbeLedgerState = {
    rows: [],
    accountWorkspaceId: null,
    personalWorkspaceId: null,
  };

  const outcome = await meterTestConnectionProbe(
    probeLedgerAdmin(state),
    PROBE_INPUT,
    () => Promise.resolve(PROBE_SUCCESS),
  );

  // The backfill guarantees a personal workspace, so this is the defensive
  // branch — but the probe's answer must survive even here.
  assertEquals(outcome, PROBE_SUCCESS);
  assertEquals(state.rows.length, 0);
});

// ---------------------------------------------------------------------------
// Full-table reads (plan 2026-09-09): settings resolution. Pure functions,
// no network. Defaults preserve today's behaviour exactly.
// ---------------------------------------------------------------------------

Deno.test("max_rows defaults to the 25 this connector shipped with", () => {
  assertEquals(resolveMaxRows({}), DEFAULT_MAX_ROWS);
  assertEquals(resolveMaxRows({ max_rows: "" }), DEFAULT_MAX_ROWS);
});

Deno.test("max_rows clamps instead of rejecting, so a typo degrades", () => {
  assertEquals(resolveMaxRows({ max_rows: "500" }), 500);
  assertEquals(resolveMaxRows({ max_rows: "99999" }), 1000);
  assertEquals(resolveMaxRows({ max_rows: "-4" }), 1);
  assertEquals(resolveMaxRows({ max_rows: "abc" }), DEFAULT_MAX_ROWS);
  assertEquals(resolveMaxRows({ max_rows: "12.9" }), 12);
  // "0" is the UI's cleared-field sentinel and must mean "default", not 1.
  assertEquals(resolveMaxRows({ max_rows: "0" }), DEFAULT_MAX_ROWS);
});

Deno.test("page_size defaults to 200 and is capped at 1000", () => {
  assertEquals(resolvePageSize({}), 200);
  assertEquals(resolvePageSize({ page_size: "50" }), 50);
  assertEquals(resolvePageSize({ page_size: "5000" }), 1000);
});

Deno.test("offset comes from the model and floors at zero", () => {
  assertEquals(resolveOffset({}), 0);
  assertEquals(resolveOffset({ offset: "40" }), 40);
  assertEquals(resolveOffset({ offset: "-1" }), 0);
  assertEquals(resolveOffset({ offset: "nonsense" }), 0);
});

Deno.test("order_by is null unless a single valid identifier is configured", () => {
  assertEquals(resolveOrderBy({}), null);
  assertEquals(resolveOrderBy({ order_by: "  " }), null);
  assertEquals(resolveOrderBy({ order_by: "id" }), "id");
  assertEquals(resolveOrderBy({ order_by: " created_at " }), "created_at");
  // Anything that is not a bare identifier is dropped rather than injected
  // into the query string.
  assertEquals(resolveOrderBy({ order_by: "id desc, name" }), null);
  assertEquals(resolveOrderBy({ order_by: "id;drop" }), null);
});

// ---------------------------------------------------------------------------
// Per-table column map. It fails CLOSED: a map that will not parse, or that
// names this table with an empty list, refuses the call instead of falling
// through to star.
// ---------------------------------------------------------------------------

Deno.test("column_map wins over the flat select_columns list", () => {
  const settings = {
    column_map: '{"products":["id","price"],"orders":["id","total"]}',
    select_columns: "name",
  };
  assertEquals(resolveColumns(settings, "products", null), "id,price");
  assertEquals(resolveColumns(settings, "orders", null), "id,total");
});

Deno.test("a table the map does not name falls back to the flat list", () => {
  const settings = { column_map: '{"products":["id"]}', select_columns: "name, price" };
  assertEquals(resolveColumns(settings, "invoices", null), "name,price");
});

Deno.test("with nothing configured the model's select is used, else star", () => {
  assertEquals(resolveColumns({}, "products", "id,name"), "id,name");
  assertEquals(resolveColumns({}, "products", null), "*");
});

Deno.test("an unparseable column_map is refused, never ignored", () => {
  // Falling through to "*" would silently widen access on a typo.
  const error = assertThrows(
    () => resolveColumns({ column_map: "{not json", select_columns: "price" }, "products", null),
    SupabaseValidationError,
  ) as SupabaseValidationError;
  assertEquals(error.code, "supabase_column_map_invalid");
});

Deno.test("a table mapped to an empty list is refused, not widened", () => {
  // Deleting the last column from a table's list is a restriction, not an
  // instruction to return every column.
  const error = assertThrows(
    () => resolveColumns({ column_map: '{"products":[]}' }, "products", null),
    SupabaseValidationError,
  ) as SupabaseValidationError;
  assertEquals(error.code, "supabase_columns_empty");
});

Deno.test("an empty map object means unrestricted, the cleared-field sentinel", () => {
  assertEquals(resolveColumns({ column_map: "{}" }, "products", null), "*");
  assertEquals(resolveColumns({ column_map: "{}", select_columns: "price" }, "products", null), "price");
});

Deno.test("column_map accepts a comma string per table as well as an array", () => {
  assertEquals(resolveColumns({ column_map: '{"products":"id, price"}' }, "products", null), "id,price");
});

// ---------------------------------------------------------------------------
// Filters are restricted to the resolved column list. `select` limits what
// comes back; without this the model could still filter on an excluded column
// and read it one equality test at a time.
// ---------------------------------------------------------------------------

Deno.test("a filter on a column outside the configured list is refused", async () => {
  let fetched = false;
  const result = await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          select_columns: "id, name, price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { email: "a@b.c" } } }),
    },
    dependencies(() => {
      fetched = true;
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_filter_refused");
  assertEquals(fetched, false, "must refuse before any vendor request");
});

Deno.test("a filter on a configured column is still allowed", async () => {
  let requested = "";
  const result = await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          select_columns: "id, name, price",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { name: "widget" } } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertEquals(result.ok, true);
  assertStringIncludes(requested, "name=eq.widget");
});

Deno.test("with no column list configured any shape-valid filter still works", async () => {
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", filters: { sku: "A1" } } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "sku=eq.A1");
});

// ---------------------------------------------------------------------------
// Full-table reads: the page loop and the result envelope. One tool call may
// issue several PostgREST requests, bounded by a row ceiling, a character
// budget and an absolute time budget, and the envelope states exactly why it
// stopped.
// ---------------------------------------------------------------------------

/** Serves successive pages and records the URL and headers of each request. */
function pagingFetch(
  pages: unknown[][],
  opts: { total?: number; failAfter?: number } = {},
): { impl: typeof fetch; urls: string[]; headers: Array<Record<string, string>> } {
  const urls: string[] = [];
  const headers: Array<Record<string, string>> = [];
  let call = 0;
  const impl = ((url: string | URL, init?: RequestInit) => {
    urls.push(String(url));
    const h: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => { h[k] = v; });
    headers.push(h);
    const index = call++;
    if (opts.failAfter !== undefined && index >= opts.failAfter) {
      return Promise.resolve(new Response("upstream exploded", { status: 500 }));
    }
    const body = pages[index] ?? [];
    const extra: Record<string, string> = {};
    if (opts.total !== undefined) {
      const start = pages.slice(0, index).reduce((n, p) => n + p.length, 0);
      extra["Content-Range"] = `${start}-${start + body.length - 1}/${opts.total}`;
    }
    return Promise.resolve(jsonResponse(body, 200, extra));
  }) as unknown as typeof fetch;
  return { impl, urls, headers };
}

function pagedTool(settings: Record<string, unknown> = {}) {
  return supabaseTool({
    settings: {
      project_url: "https://project.example.com",
      schema: "public",
      table_allow_list: ["products"],
      order_by: "id",
      ...settings,
    },
  });
}

function rows(from: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({ id: from + i, name: `row-${from + i}` }));
}

function envelopeOf(result: ConnectorResult) {
  return (result as { data: SupabaseReadEnvelope }).data;
}

Deno.test("the loop pages past 25 rows and reports an accurate count", async () => {
  const f = pagingFetch([rows(0, 200), rows(200, 60)], { total: 260 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, true);
  const data = envelopeOf(result);
  assertEquals(data.row_count, 260);
  assertEquals(data.total, 260);
  assertEquals(data.has_more, false);
  assertEquals(data.truncated_by, null);
  assertEquals(f.urls.length, 2);
  assertStringIncludes(f.urls[0], "offset=0");
  assertStringIncludes(f.urls[1], "offset=200");
  assertStringIncludes(f.urls[0], "order=id");
});

Deno.test("a short page is the server's row cap, not the end of the table", async () => {
  // PostgREST's db-max-rows can cap a response. Treating a short page as
  // exhaustion returned 100 of 900 rows claiming has_more: false.
  const f = pagingFetch([rows(0, 100), rows(100, 100), rows(200, 100)], { total: 300 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  const data = envelopeOf(result);
  assertEquals(data.row_count, 300);
  assertEquals(data.has_more, false);
  assertEquals(f.urls.length, 3);
  assertStringIncludes(f.urls[1], "offset=100");
});

Deno.test("an empty page ends the loop even when no total was returned", async () => {
  const f = pagingFetch([rows(0, 200), []]);
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.row_count, 200);
  assertEquals(data.total, null);
  assertEquals(data.has_more, false);
});

Deno.test("only the first request pays for an exact count", async () => {
  const f = pagingFetch([rows(0, 200), rows(200, 10)], { total: 210 });
  await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(f.headers[0]["prefer"], "count=exact");
  assertEquals(f.headers[1]["prefer"], undefined);
});

Deno.test("stopping on max_rows reports has_more and where to resume", async () => {
  const f = pagingFetch([rows(0, 50)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.row_count, 50);
  assertEquals(data.total, 900);
  assertEquals(data.has_more, true);
  assertEquals(data.next_offset, 50);
  assertEquals(data.truncated_by, "max_rows");
});

Deno.test("an exact multiple of max_rows does not invent a phantom next page", async () => {
  const f = pagingFetch([rows(0, 50)], { total: 50 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.has_more, false);
  assertEquals(data.next_offset, null);
  assertEquals(data.truncated_by, null);
});

Deno.test("the model's offset resumes where the previous call stopped", async () => {
  const f = pagingFetch([rows(50, 1)], { total: 900 });
  await executeConnector(
    {
      tool: pagedTool({ max_rows: "50", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", offset: "50" } }),
    },
    dependencies(f.impl),
  );
  assertStringIncludes(f.urls[0], "offset=50");
});

Deno.test("an offset with no order_by is refused, because it cannot be stable", async () => {
  // Continuing from an offset with no deterministic ORDER BY returns a
  // differently-shuffled window -- worse than an error (spec §4.8, C2).
  let fetched = false;
  const result = await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", offset: "50" } }),
    },
    dependencies(() => {
      fetched = true;
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_order_required");
  assertEquals(fetched, false, "must refuse before any vendor request");
});

Deno.test("without order_by the loop refuses to page and says why", async () => {
  // Offset paging with no deterministic ORDER BY duplicates and skips rows.
  const f = pagingFetch([rows(0, 200), rows(200, 200)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          max_rows: "500",
          page_size: "200",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(f.urls.length, 1);
  assertEquals(data.row_count, 200);
  assertEquals(data.truncated_by, "unordered");
  assertEquals(data.has_more, true);
});

Deno.test("an unordered read that already covered the table is not has_more", async () => {
  const f = pagingFetch([rows(0, 30)], { total: 30 });
  const data = envelopeOf(await executeConnector(
    {
      tool: supabaseTool({
        settings: {
          project_url: "https://project.example.com",
          schema: "public",
          table_allow_list: ["products"],
          max_rows: "500",
          page_size: "200",
        },
      }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.truncated_by, "unordered");
  assertEquals(data.has_more, false);
  assertEquals(data.next_offset, null);
});

Deno.test("the character budget stops on a whole row and says so", async () => {
  const fat = Array.from({ length: 200 }, (_, i) => ({ id: i, blob: "x".repeat(400) }));
  const f = pagingFetch([fat, fat, fat, fat], { total: 5000 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "1000", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  // C10: assert rows actually arrived, or the budget assertions pass vacuously.
  assertEquals(data.row_count > 0, true);
  assertEquals(data.truncated_by, "char_budget");
  assertEquals(data.has_more, true);
  assertEquals(data.next_offset, data.row_count);
  // The old failure was a String.slice through the middle of an object.
  for (const row of data.rows) {
    assertEquals(typeof (row as { id: number }).id, "number");
    assertEquals(typeof (row as { blob: string }).blob, "string");
  }
  assertEquals(JSON.stringify(data.rows).length <= SUPABASE_CHAR_BUDGET, true);
});

Deno.test("an upstream failure mid-loop keeps the rows already fetched", async () => {
  const f = pagingFetch([rows(0, 200)], { total: 900, failAfter: 1 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, true);
  const data = envelopeOf(result);
  assertEquals(data.row_count, 200);
  assertEquals(data.truncated_by, "upstream_error");
  assertEquals(data.has_more, true);
});

Deno.test("an upstream failure on the first page is still a hard failure", async () => {
  const f = pagingFetch([], { failAfter: 0 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_http_error");
});

Deno.test("a first row larger than the whole budget stops instead of looping", async () => {
  // Otherwise the cursor never advances and next_offset repeats forever. C10:
  // one long string is cut to 160 chars by trimValue before accounting, so the
  // row must be oversized by COLUMN COUNT, with every cell already at the cap.
  const huge = [Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`c${i}`, "x".repeat(160)]))];
  const f = pagingFetch([huge, huge, huge], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "1" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals(data.truncated_by, "no_progress");
  assertEquals(data.row_count, 0);
  // C5: never hand the model a repeatable offset.
  assertEquals(data.has_more, false);
  assertEquals(data.next_offset, null);
});

Deno.test("count mode issues exactly one HEAD request and reads no rows", async () => {
  const methods: string[] = [];
  const f = ((url: string | URL, init?: RequestInit) => {
    methods.push(init?.method ?? "GET");
    return Promise.resolve(new Response(null, {
      status: 200,
      headers: { "Content-Range": "*/4213" },
    }));
  }) as unknown as typeof fetch;
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", mode: "count" } }),
    },
    dependencies(f),
  ));
  assertEquals(methods, ["HEAD"]);
  assertEquals(data.total, 4213);
  assertEquals(data.row_count, 0);
  assertEquals(data.rows.length, 0);
});

Deno.test("an unconfigured connector still emits limit=25 in one request", async () => {
  const f = pagingFetch([rows(0, 25)], { total: 25 });
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  );
  assertEquals(f.urls.length, 1);
  assertStringIncludes(f.urls[0], "limit=25");
});

Deno.test("the loop refuses to start a hop it has no time to finish", async () => {
  // C1/C10: budget arithmetic is not enough; the deadline must actually bite.
  // A caller with almost nothing left gets zero requests, not one more.
  const f = pagingFetch([rows(0, 10)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "10" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    { ...dependencies(f.impl), callBudgetMs: 2_000 },
  ));
  assertEquals(f.urls.length, 0);
  assertEquals(data.row_count, 0);
  assertEquals(data.truncated_by, "time_budget");
});

Deno.test("a page whose body never arrives is abandoned and earlier rows survive", async () => {
  // C1: the deadline covers the body read, not just the fetch; C4: page one
  // survives. A never-delivered body on page two must not discard page one.
  const firstPage = jsonResponse(rows(0, 50), 200, { "Content-Range": "0-49/900" });
  const neverDelivered = new Response(
    new ReadableStream({ start() { /* never enqueues */ } }),
    { status: 200, headers: { "Content-Type": "application/json", "Content-Range": "50-899/900" } },
  );
  let call = 0;
  const impl = (() => {
    const index = call++;
    return Promise.resolve(index === 0 ? firstPage : neverDelivered);
  }) as unknown as typeof fetch;
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "50" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    { ...dependencies(impl), callBudgetMs: 3_200 },
  ));
  assertEquals(data.row_count, 50);
  assertEquals(data.truncated_by, "upstream_error");
  assertEquals(data.has_more, true);
});
