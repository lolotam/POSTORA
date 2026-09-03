import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { executeConnector } from "./dispatcher.ts";
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
 * long. The adapter asked for 20 rows and returned them verbatim, and
 * connectorExecution.ts serialises that into the model's messages under a
 * 2000-character budget -- so the model would have read three rows and half of
 * a fourth, cut mid-JSON. Unlike WooCommerce the table is arbitrary, so the
 * fields cannot be projected; the row count and the per-value length are what
 * can be bounded.
 */
Deno.test("Supabase fetches enough rows to cover a small catalog whole", async () => {
  // Five arbitrary rows of a 14-type price table made the model fill the gaps
  // from the stale knowledge base; see the ROW_LIMIT comment in supabase.ts.
  let requested = "";
  await executeConnector(
    {
      tool: supabaseTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ capability: "search_products", parameters: { table: "products" } }),
    },
    dependencies((url) => {
      requested = String(url);
      return Promise.resolve(jsonResponse([]));
    }),
  );
  assertStringIncludes(requested, "limit=25");
});

Deno.test("an oversized cell is truncated so the rest of the rows survive", async () => {
  const signedUrl = `https://p.supabase.co/storage/v1/object/sign/x.png?token=${"e".repeat(600)}`;
  const rows = Array.from({ length: 25 }, (_, i) => ({
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
    dependencies(() => Promise.resolve(jsonResponse(rows))),
  );

  assertEquals(result.ok, true);
  const body = serialized(result.ok === true && result.action === "execute" ? result.data : null);
  // Every row's price must still be there -- that is the answer the customer asked for.
  assertEquals((body.match(/١٨ جنية/g) || []).length, 25);
  assertEquals(body.includes("e".repeat(600)), false);
  // The whole table must fit connectorExecution's 8000-character allowance,
  // because a truncated table is not "less data" -- it is wrong data, filled in
  // from stale knowledge by the model.
  assertEquals(body.length < 8000, true, `payload is ${body.length} chars`);
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
  assertEquals(
    serialized(result.ok === true && result.action === "execute" ? result.data : null),
    '[{"id":1,"price":"١٨ جنية","in_stock":true,"qty":40}]',
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
