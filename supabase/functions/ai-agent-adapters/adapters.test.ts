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
import { handleAdapterRequest, meterTestConnectionProbe, RequestSchema, type AdminClientFactory } from "./handler.ts";
import { createAdapterDependencies } from "./dependencies.ts";
import type { ConnectorCache } from "./cache.ts";
import { wooCommerceAdapter } from "./woocommerce.ts";
import { SUPABASE_ADAPTER_OUTPUT_LIMIT } from "../_shared/connectorBudgets.ts";
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

Deno.test("execute refuses a write even when read_only_mode is off, and the refusal carries no secret", async () => {
  let fetchCalls = 0;
  const leaked = "ck_write_attempt_must_not_leak";
  const result = await executeConnector(
    {
      tool: wooTool({ read_only_mode: false }),
      credentials: { consumer_key: leaked, consumer_secret: WOO_SECRET },
      request: { ...request({ capability: "lookup_orders" }), method: "POST" },
    },
    dependencies(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({}));
    }),
  );

  assertEquals(fetchCalls, 0);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "connector_write_unsupported");
    assertStringIncludes(result.error.message, "POST");
  }
  assertEquals(serialized(result).includes(leaked), false);
  assertEquals(serialized(result).includes(WOO_SECRET), false);
});

Deno.test("missing WooCommerce credentials fail before fetch and carry no partial secret", async () => {
  let fetchCalls = 0;
  const leaked = "ck_partial_secret_must_not_leak";
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: leaked },
      request: request(),
    },
    dependencies(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse([]));
    }),
  );

  assertEquals(fetchCalls, 0);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "woocommerce_configuration_invalid");
  }
  assertEquals(serialized(result).includes(leaked), false);
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

const ORDER_NOTE = "Customer asked to cancel on WhatsApp (Postora)";

function updateOrderRequest(overrides: Partial<ConnectorTool> = {}): {
  tool: ConnectorTool;
  credentials: { consumer_key: string; consumer_secret: string };
  request: ExecuteConnectorRequest;
} {
  return {
    tool: wooTool({ read_only_mode: false, ...overrides }),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: {
      action: "execute",
      capability: "update_order",
      method: "POST",
      internalProcedure: true,
      parameters: {
        order_id: "10432",
        note: ORDER_NOTE,
        status: "cancelled",
        expected_statuses: ["pending", "on-hold", "processing"],
      },
    },
  };
}

Deno.test("update_order in read-only mode performs zero fetches", async () => {
  let fetchCalls = 0;
  const result = await executeConnector(
    updateOrderRequest({ read_only_mode: true }),
    dependencies(() => {
      fetchCalls += 1;
      return Promise.resolve(jsonResponse({}));
    }),
  );
  assertEquals(fetchCalls, 0);
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.error.code, "read_only_violation");
});

Deno.test("update_order posts the note before it changes status", async () => {
  const calls: Array<{ method: string; url: string; body: string | null }> = [];
  const result = await executeConnector(updateOrderRequest(), dependencies((url, init) => {
    calls.push({ method: init?.method ?? "GET", url: String(url), body: typeof init?.body === "string" ? init.body : null });
    if (calls.length === 1) return Promise.resolve(jsonResponse({ id: 10432, status: "processing" }));
    if (calls.length === 2) return Promise.resolve(jsonResponse({ id: 9, note: ORDER_NOTE }));
    if (calls.length === 3) return Promise.resolve(jsonResponse({ id: 10432, status: "on-hold" }));
    return Promise.resolve(jsonResponse({ id: 10432, status: "cancelled" }));
  }));
  assertEquals(calls.map((call) => call.method), ["GET", "POST", "GET", "PUT"]);
  assertStringIncludes(calls[1].url, "/orders/10432/notes");
  assertEquals(JSON.parse(calls[1].body ?? "{}"), { note: ORDER_NOTE, customer_note: false });
  assertStringIncludes(calls[3].url, "/orders/10432");
  assertEquals(calls[3].url.includes("/notes"), false);
  assertEquals(JSON.parse(calls[3].body ?? "{}"), { status: "cancelled" });
  assertEquals(result, {
    ok: true, vendor: "woocommerce", action: "execute", capability: "update_order",
    data: { changed: true, status: "cancelled" },
  });
});

Deno.test("update_order does not PUT when the re-read left the expected statuses", async () => {
  const methods: string[] = [];
  const result = await executeConnector(updateOrderRequest(), dependencies((_url, init) => {
    methods.push(init?.method ?? "GET");
    if (methods.length === 1) return Promise.resolve(jsonResponse({ id: 10432, status: "pending" }));
    if (methods.length === 2) return Promise.resolve(jsonResponse({ id: 9, note: ORDER_NOTE }));
    return Promise.resolve(jsonResponse({ id: 10432, status: "completed" }));
  }));
  assertEquals(methods, ["GET", "POST", "GET"]);
  assertEquals(result, {
    ok: true, vendor: "woocommerce", action: "execute", capability: "update_order",
    data: { changed: false, status: "completed" },
  });
});

Deno.test("update_order maps a 401 to store_write_denied and stops", async () => {
  let fetchCalls = 0;
  const result = await executeConnector(updateOrderRequest(), dependencies(() => {
    fetchCalls += 1;
    return Promise.resolve(jsonResponse({ message: `bad ${WOO_KEY}` }, 401));
  }));
  assertEquals(fetchCalls, 1);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.code, "store_write_denied");
    assertEquals(result.error.vendor_status, 401);
  }
  assertEquals(serialized(result).includes(WOO_KEY), false);
});

Deno.test("a cancelled order whose latest note is ours is already done", async () => {
  const methods: string[] = [];
  const result = await executeConnector(updateOrderRequest(), dependencies((url, init) => {
    methods.push(init?.method ?? "GET");
    if (!String(url).includes("/notes")) return Promise.resolve(jsonResponse({ id: 10432, status: "cancelled" }));
    return Promise.resolve(jsonResponse([
      { id: 1, note: "older" },
      { id: 4, note: ORDER_NOTE },
    ]));
  }));
  assertEquals(methods, ["GET", "GET"]);
  assertEquals(result, {
    ok: true, vendor: "woocommerce", action: "execute", capability: "update_order",
    data: { changed: true, status: "cancelled" },
  });
});

Deno.test("get_product reads a variation and projects the stock fields", async () => {
  const seen: string[] = [];
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: {
        action: "execute",
        capability: "get_product",
        internalProcedure: true,
        parameters: { product_id: "55", parent_id: "10" },
      },
    },
    dependencies((url) => {
      seen.push(String(url));
      return Promise.resolve(jsonResponse({
        id: 55, parent_id: 10, name: "Hat / Blue", price: "3.500", stock_status: "instock",
        permalink: "https://store.example.com/hat", description: "<p>secret</p>", sku: "HAT",
      }));
    }),
  );
  assertEquals(seen.length, 1);
  assertStringIncludes(seen[0], "/products/10/variations/55");
  assertEquals(result, {
    ok: true, vendor: "woocommerce", action: "execute", capability: "get_product",
    data: {
      id: 55, parent_id: 10, name: "Hat / Blue", price: "3.500", stock_status: "instock",
      permalink: "https://store.example.com/hat",
    },
  });
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

const PRODUCT_FIELD_LIST = [
  "id",
  "parent_id",
  "name",
  "sku",
  "price",
  "regular_price",
  "sale_price",
  "on_sale",
  "stock_status",
  "stock_quantity",
  "permalink",
  // Nested fields the projection reads; without them product answers lose their categories.
  "categories",
].join(",");
const ORDER_FIELD_LIST = ["id", "number", "status", "total", "currency", "date_created", "line_items"].join(",");

async function wooUrls(
  capability: "search_products" | "check_stock" | "lookup_orders",
  parameters: Record<string, unknown>,
): Promise<string[]> {
  const seen: string[] = [];
  await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ capability, parameters }),
    },
    dependencies((url) => {
      seen.push(String(url));
      return Promise.resolve(jsonResponse(capability === "lookup_orders" ? { id: 1 } : []));
    }),
  );
  return seen;
}

Deno.test("WooCommerce product, stock, order and category URLs ask only for the fields we keep", async () => {
  const [search] = await wooUrls("search_products", { query: "hat" });
  assertStringIncludes(search, `_fields=${PRODUCT_FIELD_LIST}`);
  assertEquals(new URL(search).searchParams.get("_fields"), PRODUCT_FIELD_LIST);

  const [stock] = await wooUrls("check_stock", { sku: "HAT-1" });
  assertStringIncludes(stock, `_fields=${PRODUCT_FIELD_LIST}`);
  assertEquals(new URL(stock).searchParams.get("_fields"), PRODUCT_FIELD_LIST);

  const [byId] = await wooUrls("lookup_orders", { order_id: "10432" });
  assertStringIncludes(byId, `_fields=${ORDER_FIELD_LIST}`);
  assertEquals(new URL(byId).searchParams.get("_fields"), ORDER_FIELD_LIST);

  const [bySearch] = await wooUrls("lookup_orders", { query: "10432" });
  assertStringIncludes(bySearch, `_fields=${ORDER_FIELD_LIST}`);
  assertEquals(new URL(bySearch).searchParams.get("_fields"), ORDER_FIELD_LIST);

  const categoryUrls = await wooUrlFor(
    { query: "hat", category: "Men" },
    [[{ id: 3, name: "Men" }], []],
  );
  assertStringIncludes(categoryUrls[0], "_fields=id,name");
  assertEquals(new URL(categoryUrls[0]).searchParams.get("_fields"), "id,name");
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
  // Restored contract (see SUPABASE_ADAPTER_OUTPUT_LIMIT): the reply side
  // passes this envelope to the model whole only if it fits the Supabase
  // output cap, and the adapter's own character budget bounds it further.
  assertEquals(JSON.stringify(data).length <= SUPABASE_ADAPTER_OUTPUT_LIMIT, true);
  assertEquals(JSON.stringify(data.rows).length <= SUPABASE_CHAR_BUDGET, true);
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
  
  assertEquals(resolveOrderBy({ order_by: "id;drop" }), null);
  // A tie-breaker makes a non-unique lead column deterministic across the
  // separate queries offset paging issues.
  assertEquals(resolveOrderBy({ order_by: "status,id" }), "status,id");
  assertEquals(resolveOrderBy({ order_by: "status, id " }), "status,id");
  // The card's cleared-field marker.
  assertEquals(resolveOrderBy({ order_by: "-" }), null);
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
  assertEquals(resolveColumns(settings, "products", null).select, "id,price");
  assertEquals(resolveColumns(settings, "orders", null).select, "id,total");
});

Deno.test("a table mapped to * is explicitly unrestricted, not refused", () => {
  // The picker names every allowed table so narrowing one cannot deny another;
  // the ones nobody narrowed carry "*".
  const settings = { column_map: '{"products":["id"],"orders":"*"}' };
  assertEquals(resolveColumns(settings, "orders", null).select, "*");
  // And it is not operator approval of any particular column, so the
  // structural redaction pass still applies to those rows.
  assertEquals(resolveColumns(settings, "orders", null).explicit, false);
  assertEquals(resolveColumns(settings, "products", null).select, "id");
  assertEquals(resolveColumns(settings, "products", null).explicit, true);
});

Deno.test("a table an active map does not name is refused, not widened", () => {
  // Deleting or mistyping a table's entry must not take the agent from a
  // scoped list to every column.
  const settings = { column_map: '{"products":["id"]}', select_columns: "name, price" };
  const error = assertThrows(
    () => resolveColumns(settings, "invoices", null),
    SupabaseValidationError,
  ) as SupabaseValidationError;
  assertEquals(error.code, "supabase_columns_unmapped");
});

Deno.test("with nothing configured the model's select is used, else star", () => {
  // A model-chosen select is NOT operator approval: it could name
  // `password`, so it must keep the structural redaction pass.
  assertEquals(resolveColumns({}, "products", "id,name").select, "id,name");
  assertEquals(resolveColumns({}, "products", "id,name").explicit, false);
  assertEquals(resolveColumns({ select_columns: "id" }, "products", null).explicit, true);
  assertEquals(resolveColumns({}, "products", null).select, "*");
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
  assertEquals(resolveColumns({ column_map: "{}" }, "products", null).select, "*");
  assertEquals(resolveColumns({ column_map: "{}", select_columns: "price" }, "products", null).select, "price");
});

Deno.test("column_map accepts a comma string per table as well as an array", () => {
  assertEquals(resolveColumns({ column_map: '{"products":"id, price"}' }, "products", null).select, "id,price");
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
  // Exact param match: an assertStringIncludes("limit=25") would also pass
  // against limit=250.
  assertEquals(new URL(f.urls[0]).searchParams.get("limit"), "25");
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

// ---------------------------------------------------------------------------
// Redaction, narrowed to credential VALUES on a successful Supabase read
// (plan Task 7; revision 3 corrections C7/C10; guard fixes G5/G6). Customer
// columns named token/api_key/key and hex digests are the payload the
// connector exists to deliver; the connector's own credentials still never
// survive, in any representation.
// ---------------------------------------------------------------------------

Deno.test("a customer column named token survives when the operator named it", async () => {
  const f = pagingFetch([[{ id: 1, token: "ABC-123", api_key: "plain", key: "k1" }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ select_columns: "id, token, api_key, key" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { token: string }).token, "ABC-123");
  assertEquals((data.rows[0] as { api_key: string }).api_key, "plain");
  assertEquals((data.rows[0] as { key: string }).key, "k1");
});

Deno.test("a 64-character hex column is customer data when the operator named it", async () => {
  const digest = "a".repeat(64);
  const f = pagingFetch([[{ id: 1, sha256: digest }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ select_columns: "id, sha256" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { sha256: string }).sha256, digest);
});

Deno.test("with no column list configured a secret-looking column is still redacted", async () => {
  // The operator vouched for nothing here, so a row may carry a password or a
  // refresh token nobody chose to expose. Only a named column skips this pass.
  const f = pagingFetch([[{ id: 1, password: "hunter2", refresh_token: "rt-9", name: "widget" }]], {
    total: 1,
  });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  const row = data.rows[0] as Record<string, unknown>;
  assertEquals(row.password, "[REDACTED]");
  assertEquals(row.refresh_token, "[REDACTED]");
  assertEquals(row.name, "widget");
});

Deno.test("the connector's own anon key is still stripped if a row echoes it", async () => {
  const f = pagingFetch([[{ id: 1, note: `key is ${SUPABASE_ANON_KEY}` }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { note: string }).note.includes(SUPABASE_ANON_KEY), false);
});

Deno.test("a credential longer than the cell cap leaves no surviving prefix", async () => {
  // G6: redaction must run BEFORE trimValue. A 260-character key that was
  // trimmed first would leave an unmatchable 160-character prefix behind --
  // asserting only on the whole key cannot catch that reordering.
  const longKey = makeJwt({ role: "anon", pad: "x".repeat(200) });
  const f = pagingFetch([[{ id: 1, note: `echo ${longKey}` }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: longKey },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  const note = (data.rows[0] as { note: string }).note;
  assertEquals(note.includes(longKey), false);
  assertEquals(note.includes(longKey.slice(0, 160)), false);
});

Deno.test("a bearer token in a customer row is still redacted by the generic rule", async () => {
  // Rows skip the key-name pass after Task 7; the ^Bearer rule inside
  // stripCredentialValues is the only thing still catching these.
  const f = pagingFetch([[{ id: 1, note: "Bearer abc.def.ghi" }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertEquals((data.rows[0] as { note: string }).note, "[REDACTED]");
});

Deno.test("a deeply nested JSONB column is bounded, not recursed forever", async () => {
  let nested: Record<string, unknown> = { leaf: "ok" };
  for (let i = 0; i < 40; i++) nested = { child: nested };
  const f = pagingFetch([[{ id: 1, payload: nested }]], { total: 1 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl),
  ));
  assertStringIncludes(JSON.stringify(data.rows[0]), "[REDACTED]");
});

Deno.test("WooCommerce results keep the generic key-name and hex redaction", async () => {
  // C10: Woo's own projection already drops a `token` field, so asserting on
  // one proves nothing. `sku` survives the projection, and a 64-hex sku is
  // redacted only by the generic pass this test protects.
  const digest = "b".repeat(64);
  const result = await executeConnector(
    {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request(),
    },
    dependencies(() => Promise.resolve(jsonResponse([{ id: 1, name: "Hat", sku: digest }]))),
  );
  assertEquals(result.ok, true);
  const body = serialized(result.ok === true && result.action === "execute" ? result.data : null);
  assertEquals(body.includes(digest), false);
  assertStringIncludes(body, "[REDACTED]");
});

Deno.test("a Supabase failure path keeps credential redaction", async () => {
  // C10: a refusal with a fixed message carries nothing that needs redacting.
  // The fetch rejects on the FIRST page with the anon key inside the error,
  // so the credential actually enters the failure path.
  const result = await executeConnector(
    {
      tool: pagedTool(),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(() => Promise.reject(new Error(`network copied ${SUPABASE_ANON_KEY}`))),
  );
  assertEquals(result.ok, false);
  assertEquals(serialized(result).includes(SUPABASE_ANON_KEY), false);
});

// ---------------------------------------------------------------------------
// Guard fix G2: next_offset must never name a call the connector itself
// would refuse or that repeats the request identically.
// ---------------------------------------------------------------------------

Deno.test("an unordered truncation offers no offset it would refuse to continue", async () => {
  // has_more stays true -- more rows genuinely may exist -- but a follow-up
  // with any offset is GUARANTEED supabase_order_required, so handing one
  // back burns an iteration on a call that always errors. The model should
  // report that the connector needs an order column instead.
  const f = pagingFetch([rows(0, 200)], { total: 900 });
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
  assertEquals(data.has_more, true);
  assertEquals(data.next_offset, null);
});

Deno.test("a time-budget stop with zero rows does not echo the requested offset", async () => {
  // next_offset equal to the offset just requested means the model retries
  // identically forever.
  const f = pagingFetch([rows(40, 10)], { total: 900 });
  const data = envelopeOf(await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "10" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products", offset: "40" } }),
    },
    { ...dependencies(f.impl), callBudgetMs: 2_000 },
  ));
  assertEquals(f.urls.length, 0);
  assertEquals(data.row_count, 0);
  assertEquals(data.truncated_by, "time_budget");
  assertEquals(data.next_offset, null);
});

// ---------------------------------------------------------------------------
// Guard fix G3: five break sites stop with "upstream_error" on a SUCCESSFUL
// envelope, so without an explicit log event the failure produces no
// telemetry at all -- just a short answer the model presents as complete.
// ---------------------------------------------------------------------------

Deno.test("a mid-loop upstream failure is logged, not silent", async () => {
  const logged: unknown[] = [];
  const f = pagingFetch([rows(0, 200)], { total: 900, failAfter: 1 });
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500", page_size: "200" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    dependencies(f.impl, [], logged),
  );
  assertEquals(result.ok, true);
  assertEquals(envelopeOf(result).truncated_by, "upstream_error");
  const failure = logged.find(
    (event) => (event as { event?: string }).event === "connector_failure",
  );
  assertEquals(typeof failure === "object", true);
  const event = failure as { vendor: string; operation: string; error_code: string; vendor_status?: number };
  assertEquals(event.vendor, "supabase");
  assertEquals(event.operation, "search_products");
  assertEquals(event.error_code, "supabase_http_error");
  assertEquals(event.vendor_status, 500);
});

// ---------------------------------------------------------------------------
// Guard fix G4: buildUrl writes filters with searchParams.set before the page
// loop overwrites order/limit/offset on the same URL (and `select` would be
// overwritten outright), so a column with one of those names was silently
// dropped -- the connector returned the whole table where the model asked for
// one row, a wrong answer delivered as a right one.
// ---------------------------------------------------------------------------

Deno.test("a filter named like a PostgREST reserved word is refused, not silently dropped", async () => {
  for (const column of ["select", "order", "limit", "offset", "and", "or", "not"]) {
    let fetched = false;
    const result = await executeConnector(
      {
        tool: supabaseTool(),
        credentials: { anon_key: SUPABASE_ANON_KEY },
        request: request({ parameters: { table: "products", filters: { [column]: "x" } } }),
      },
      dependencies(() => {
        fetched = true;
        return Promise.resolve(jsonResponse([]));
      }),
    );
    assertEquals(result.ok, false, `filter column "${column}" was not refused`);
    assertEquals((result as { error: { code: string } }).error.code, "supabase_filter_refused");
    assertEquals(fetched, false, `filter column "${column}" must be refused before any vendor request`);
  }
});

// ---------------------------------------------------------------------------
// Guard fix G1: the caller's remaining budget has to cross the HTTP boundary,
// or the page loop always assumes a full ceiling while the caller may abort
// at a fraction of it.
// ---------------------------------------------------------------------------

Deno.test("createAdapterDependencies carries a granted call budget into the adapter seam", () => {
  assertEquals(createAdapterDependencies().callBudgetMs, undefined);
  assertEquals(createAdapterDependencies(1_600).callBudgetMs, 1_600);
  assertEquals(createAdapterDependencies(-1).callBudgetMs, undefined);
});

Deno.test("the internal adapter contract accepts an optional call_budget_ms", () => {
  const base = {
    tool_id: "00000000-0000-0000-0000-000000000003",
    action: "execute",
    capability: "search_products",
    parameters: {},
  };
  assertEquals(RequestSchema.safeParse({ ...base, call_budget_ms: 4_000 }).success, true);
  assertEquals(RequestSchema.safeParse({ ...base, call_budget_ms: -2 }).success, false);
  assertEquals(RequestSchema.safeParse({ ...base, call_budget_ms: "lots" }).success, false);
});

// ---------------------------------------------------------------------------
// Also-fix: the first-page deadline expiry escaped as a generic
// connector_request_failed; it needs its own stable code.
// ---------------------------------------------------------------------------

Deno.test("a first page that outlives the deadline is a named timeout, not a generic failure", async () => {
  const hanging = new Response(
    new ReadableStream({ start() { /* never enqueues */ } }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
  const result = await executeConnector(
    {
      tool: pagedTool({ max_rows: "500" }),
      credentials: { anon_key: SUPABASE_ANON_KEY },
      request: request({ parameters: { table: "products" } }),
    },
    { ...dependencies(() => Promise.resolve(hanging)), callBudgetMs: 3_200 },
  );
  assertEquals(result.ok, false);
  assertEquals((result as { error: { code: string } }).error.code, "supabase_timeout");
});

// ---------------------------------------------------------------------------
// Task 9 (plan 2026-09-25): the WooCommerce adapter behind a ConnectorCache.
// Category ids are cached for a day, product searches for 120 s; stock and
// order lookups and test_connection never touch the cache, and a broken cache
// is indistinguishable from no cache except in speed.
// ---------------------------------------------------------------------------

function memoryCache(clock: { now: number }): {
  cache: ConnectorCache;
  reads: () => number;
  writes: () => number;
} {
  const rows = new Map<string, { value: unknown; expiresAt: number }>();
  let reads = 0;
  let writes = 0;
  return {
    cache: {
      async get(key) {
        reads += 1;
        const row = rows.get(key);
        return row && row.expiresAt > clock.now ? row.value : null;
      },
      async set(key, _toolId, value, ttlSeconds) {
        writes += 1;
        rows.set(key, { value, expiresAt: clock.now + ttlSeconds * 1000 });
      },
    },
    reads: () => reads,
    writes: () => writes,
  };
}

/** Serves one category list and an endless product list, recording every URL. */
function wooStoreFetch(urls: string[]): typeof fetch {
  return ((_url: string | URL, _init?: RequestInit) => {
    const url = String(_url);
    urls.push(url);
    if (url.includes("/products/categories")) {
      return Promise.resolve(jsonResponse([{ id: 77, name: "Men's perfumes" }]));
    }
    return Promise.resolve(jsonResponse([{ id: 1, name: "Hat", price: "5.00", sku: "HAT-1" }]));
  }) as typeof fetch;
}

Deno.test("two identical category searches make one category request and one search request in total", async () => {
  const clock = { now: 1_700_000_000_000 };
  const mem = memoryCache(clock);
  const urls: string[] = [];
  const deps = { ...dependencies(wooStoreFetch(urls)), cache: mem.cache };
  const invocation = {
    tool: wooTool(),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: request({ parameters: { query: "hat", category: "Men's Perfumes " } }),
  };

  const first = await executeConnector(invocation, deps);
  const second = await executeConnector(invocation, deps);

  assertEquals(first.ok, true);
  assertEquals(second, first);
  // One category lookup + one product search: the second call was fully cached.
  assertEquals(urls.length, 2);
});

Deno.test("the same search after the 120 s TTL refetches the search but not the category", async () => {
  const clock = { now: 1_700_000_000_000 };
  const mem = memoryCache(clock);
  const urls: string[] = [];
  const deps = { ...dependencies(wooStoreFetch(urls)), cache: mem.cache };
  const invocation = {
    tool: wooTool(),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: request({ parameters: { query: "hat", category: "Men's Perfumes" } }),
  };
  await executeConnector(invocation, deps);

  clock.now += 121_000;
  const result = await executeConnector(invocation, deps);

  assertEquals(result.ok, true);
  assertEquals(urls.length, 3);
  assertStringIncludes(urls[2], "/wp-json/wc/v3/products?");
  assertEquals(urls[2].includes("/products/categories"), false);
});

Deno.test("check_stock and lookup_orders never touch the cache", async () => {
  const mem = memoryCache({ now: 1_700_000_000_000 });
  const urls: string[] = [];
  const deps = { ...dependencies(wooStoreFetch(urls)), cache: mem.cache };
  const credentials = { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET };

  await executeConnector({
    tool: wooTool(),
    credentials,
    request: request({ capability: "check_stock", parameters: { sku: "HAT-1" } }),
  }, deps);
  await executeConnector({
    tool: wooTool(),
    credentials,
    request: request({ capability: "lookup_orders", parameters: { order_id: "10432" } }),
  }, deps);

  assertEquals(mem.reads(), 0);
  assertEquals(mem.writes(), 0);
});

Deno.test("a throwing cache still returns the live result", async () => {
  const urls: string[] = [];
  const exploding: ConnectorCache = {
    get() {
      return Promise.reject(new Error("cache down"));
    },
    set() {
      return Promise.reject(new Error("cache down"));
    },
  };
  const first = await executeConnector({
    tool: wooTool(),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: request({ parameters: { query: "hat", category: "Men's Perfumes" } }),
  }, { ...dependencies(wooStoreFetch(urls)), cache: exploding });

  assertEquals(first.ok, true);
  // The category lookup and the search both had to go live despite the cache.
  assertEquals(urls.length, 2);
});

Deno.test("testConnection never touches the cache", async () => {
  const mem = memoryCache({ now: 1_700_000_000_000 });
  const urls: string[] = [];
  const deps = { ...dependencies(wooStoreFetch(urls)), cache: mem.cache };

  const result = await executeConnector({
    tool: wooTool(),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: request({ action: "test_connection", capability: undefined, parameters: {} }),
  }, deps);

  assertEquals(result.ok, true);
  assertEquals(mem.reads() + mem.writes(), 0);
});

for (const liveId of [88, 77, 99]) {
  Deno.test(`an empty cached-category search resolves live once (live id ${liveId})`, async () => {
    const clock = { now: 1_700_000_000_000 };
    const mem = memoryCache(clock);
    const urls: string[] = [];
    const invocation = {
      tool: wooTool(),
      credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
      request: request({ parameters: { category: "Men's perfumes" } }),
    };
    await executeConnector(invocation, { ...dependencies(wooStoreFetch([])), cache: mem.cache });
    clock.now += 121_000;
    const fetchImpl = ((input: string | URL) => {
      const url = String(input);
      urls.push(url);
      return Promise.resolve(jsonResponse(url.includes("/categories")
        ? [{ id: liveId, name: "Men's perfumes" }]
        : new URL(url).searchParams.get("category") === "88" ? [{ id: 2, name: "Recovered product" }] : []));
    }) as typeof fetch;
    const deps = { ...dependencies(fetchImpl), cache: mem.cache };
    const result = await executeConnector(invocation, deps);
    assertEquals(result.ok && result.data, liveId === 88 ? [{ id: 2, name: "Recovered product" }] : []);
    assertEquals(urls.length, liveId === 77 ? 2 : 3);
    assertStringIncludes(urls[0], "category=77");
    assertStringIncludes(urls[1], "/products/categories?");
    if (liveId !== 77) assertStringIncludes(urls[2], `category=${liveId}`);

    clock.now += 121_000;
    await executeConnector(invocation, { ...dependencies(wooStoreFetch(urls)), cache: mem.cache });
    assertStringIncludes(urls[urls.length - 1], `category=${liveId}`);
  });
}

Deno.test("execute with test_connection action and a search capability bypasses every cache", async () => {
  const mem = memoryCache({ now: 1_700_000_000_000 });
  const urls: string[] = [];
  const result = await wooCommerceAdapter.execute({
    tool: wooTool(),
    credentials: { consumer_key: WOO_KEY, consumer_secret: WOO_SECRET },
    request: request({ action: "test_connection", parameters: { category: "Men's perfumes" } }),
  }, { ...dependencies(wooStoreFetch(urls)), cache: mem.cache });
  assertEquals(mem.reads(), 0);
  assertEquals(mem.writes(), 0);
  assertEquals(result.ok && result.action, "test_connection");
  assertEquals(urls.length, 1);
});
