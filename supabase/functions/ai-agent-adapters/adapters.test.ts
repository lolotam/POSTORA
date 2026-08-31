import {
  assertEquals,
  assertStringIncludes,
} from "https://deno.land/std@0.208.0/assert/mod.ts";
import { executeConnector } from "./dispatcher.ts";
import {
  type AdapterDependencies,
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
