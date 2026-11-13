import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { executeConnector } from "./dispatcher.ts";
import type { AdapterDependencies, ConnectorResult, ConnectorTool } from "./types.ts";

// The catalog search the curemedkw agent needs (2026-11-12): an exact-match
// table filter cannot find "كريم الكعب", the store's own RPC can.

const ANON_KEY = (() => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
  return `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ role: "anon" })}.signature`;
})();

const FIXTURE: Record<string, unknown>[] = JSON.parse(
  await Deno.readTextFile(new URL("./fixtures/curemed_search.json", import.meta.url)),
);

function catalogTool(extra: Record<string, unknown> = { rpc_allow_list: "agent_search_products" }): ConnectorTool {
  return {
    id: "00000000-0000-0000-0000-000000000003",
    connector_type: "supabase",
    settings: {
      project_url: "https://catalog.example.com",
      schema: "public",
      table_allow_list: "agent_catalog_products",
      ...extra,
    },
    permissions: { search_products: true, check_stock: false, lookup_orders: false },
    read_only_mode: true,
  };
}

interface Call { url: string; method: string; body: unknown; headers: Record<string, string> }

/**
 * The answers a target gives. `status` models a target that answers with an
 * error instead of rows -- PostgREST answers 405 when a GET function tries to
 * write, because the read-only transaction refused it.
 */
function recordingDeps(
  answers: unknown[][],
  options: { status?: number } = {},
): { deps: AdapterDependencies; calls: Call[] } {
  const status = options.status ?? 200;
  const calls: Call[] = [];
  const deps: AdapterDependencies = {
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      const rows = answers[Math.min(calls.length - 1, answers.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(rows), {
          status,
          headers: { "Content-Type": "application/json" },
        }),
      );
    },
    timeoutMs: 1_000,
    maxRedirects: 3,
    assertPublicHttpsUrl: (rawUrl) => Promise.resolve(new URL(rawUrl)),
    log: () => {},
  };
  return { deps, calls };
}

/**
 * The arguments the call carried, read back from its query string.
 *
 * The catalog function is called with GET, so the arguments ride in the query
 * string where PostgREST matches them to the function's parameter names.
 */
function argsOf(call: Call): Record<string, string> {
  return Object.fromEntries(new URL(call.url).searchParams.entries());
}

function search(tool: ConnectorTool, parameters: Record<string, unknown>, deps: AdapterDependencies) {
  return executeConnector(
    {
      tool,
      credentials: { anon_key: ANON_KEY },
      request: { action: "execute", capability: "search_products", parameters },
    },
    deps,
  );
}

function dataOf(result: ConnectorResult): Record<string, unknown> {
  if (!result.ok || !("data" in result)) throw new Error(`expected rows, got ${JSON.stringify(result)}`);
  return result.data as Record<string, unknown>;
}

function errorCodeOf(result: ConnectorResult): string | undefined {
  return result.ok ? undefined : result.error.code;
}

Deno.test("an allow-listed catalog function is called with the customer's words and the result count", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(catalogTool(), { query: "  كريم الكعب " }, deps);

  assertEquals(calls.map(({ url, method }) => [new URL(url).pathname, method]), [
    ["/rest/v1/rpc/agent_search_products", "GET"],
  ]);
  assertEquals(argsOf(calls[0]), { q: "كريم الكعب", max_results: "8" });
  assertEquals(dataOf(result).row_count, 2);
});

Deno.test("catalog rows keep the store link and the price and shopping flags", async () => {
  const { deps } = recordingDeps([FIXTURE]);

  const rows = dataOf(await search(catalogTool(), { query: "heel" }, deps)).rows as Record<string, unknown>[];

  assertEquals(
    rows.map((row) => [row.product_url, row.price_hidden, row.shopping_enabled]),
    [
      ["https://example.com/product/test-heel-cream", false, true],
      ["https://example.com/product/test-heel-balm", true, false],
    ],
  );
});

Deno.test("result count is clamped to 1..25 and the parameter names follow the settings", async () => {
  const cases: Array<[unknown, number]> = [[99, 25], [0, 8], [3, 3], ["x", 8]];
  for (const [asked, sent] of cases) {
    const { deps, calls } = recordingDeps([FIXTURE]);
    await search(
      catalogTool({ rpc_allow_list: "agent_search_products", rpc_query_param: "term", rpc_limit_param: "lim" }),
      { query: "heel", max_results: asked },
      deps,
    );
    assertEquals(argsOf(calls[0]), { term: "heel", lim: String(sent) }, `max_results ${String(asked)}`);
  }
});

Deno.test("an empty query is refused before any request (2026-11-10 empty-filter call)", async () => {
  for (const query of [undefined, "", "   "]) {
    const { deps, calls } = recordingDeps([FIXTURE]);
    const result = await search(catalogTool(), query === undefined ? {} : { query }, deps);
    assertEquals(errorCodeOf(result), "supabase_query_required");
    assertEquals(calls.length, 0);
  }
});

Deno.test("no rows for several words retries once with the longest word and says so", async () => {
  const { deps, calls } = recordingDeps([[], FIXTURE]);

  const data = dataOf(await search(catalogTool(), { query: "كريم للكعب المتشقق" }, deps));

  assertEquals(calls.map((call) => argsOf(call)), [
    { q: "كريم للكعب المتشقق", max_results: "8" },
    { q: "المتشقق", max_results: "8" },
  ]);
  assertEquals([data.row_count, data.retried_with], [2, "المتشقق"]);
});

Deno.test("no rows for a single word is answered without a retry", async () => {
  const { deps, calls } = recordingDeps([[]]);

  const data = dataOf(await search(catalogTool(), { query: "xyz" }, deps));

  assertEquals([calls.length, data.row_count, data.retried_with], [1, 0, undefined]);
});

Deno.test("the model still cannot name a function as a table", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(catalogTool({}), { table: "rpc/agent_search_products", query: "heel" }, deps);

  assertEquals([errorCodeOf(result), calls.length], ["supabase_rpc_refused", 0]);
});

Deno.test("an allow-list entry that is not a bare function name is not called", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(catalogTool({ rpc_allow_list: "../admin_fn" }), { query: "heel" }, deps);

  assertEquals([errorCodeOf(result), calls.length], ["supabase_configuration_invalid", 0]);
});

Deno.test("without an RPC allow-list search reads the table as before", async () => {
  // "-" is what the connector card saves when the operator clears the field.
  for (const extra of [{}, { rpc_allow_list: "-", rpc_query_param: "-" }]) {
    const { deps, calls } = recordingDeps([FIXTURE]);

    await search(catalogTool(extra), { query: "heel" }, deps);

    assertEquals([new URL(calls[0].url).pathname, calls[0].method], ["/rest/v1/agent_catalog_products", "GET"]);
  }
});

Deno.test("a cleared argument name falls back to its default", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  await search(catalogTool({ rpc_allow_list: "agent_search_products", rpc_query_param: "-" }), { query: "heel" }, deps);

  assertEquals(argsOf(calls[0]), { q: "heel", max_results: "8" });
});

Deno.test("the catalog function is called with GET, so PostgREST reads it in a read-only transaction", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  await search(catalogTool(), { query: "heel" }, deps);

  // The read-only boundary is the server's, not a preference the target may
  // ignore: a GET runs in a READ ONLY transaction for every volatility class, so
  // Postgres refuses a write inside it and nothing can be committed.
  assertEquals(calls[0].method, "GET");
  assertEquals(calls[0].body, null, "the arguments ride in the query string, not a body");
  assertEquals(calls[0].headers.Prefer, undefined, "the call does not ask for a rollback");
  assertEquals(calls[0].headers["Cache-Control"], "no-store");
});

Deno.test("a function that tries to write is refused and nothing was committed", async () => {
  // PostgREST answers 405 when a GET function tries to write: the read-only
  // transaction refused the write, so the call failed closed.
  const { deps, calls } = recordingDeps([FIXTURE], { status: 405 });

  const result = await search(catalogTool(), { query: "heel" }, deps);

  assertEquals(errorCodeOf(result), "supabase_search_function_writes");
  assertEquals(calls.length, 1);
});

Deno.test("an argument name PostgREST reads for itself is refused before any request", async () => {
  for (const extra of [{ rpc_query_param: "select" }, { rpc_limit_param: "limit" }]) {
    const { deps, calls } = recordingDeps([FIXTURE]);

    const result = await search(
      catalogTool({ rpc_allow_list: "agent_search_products", ...extra }),
      { query: "heel" },
      deps,
    );

    assertEquals([errorCodeOf(result), calls.length], ["supabase_configuration_invalid", 0]);
  }
});

Deno.test("two argument names that are the same are refused before any request", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(
    catalogTool({ rpc_allow_list: "agent_search_products", rpc_query_param: "term", rpc_limit_param: "term" }),
    { query: "heel" },
    deps,
  );

  assertEquals([errorCodeOf(result), calls.length], ["supabase_configuration_invalid", 0]);
});

// ---------------------------------------------------------------------------
// The catalog connector names a FUNCTION, not a table (curemedkw, 2026-11-12).
// The plan's reference connector carries no table allow-list at all, so the
// table settings cannot be read before the execution path is chosen.
// ---------------------------------------------------------------------------

function rpcOnlyTool(extra: Record<string, unknown> = {}): ConnectorTool {
  return {
    id: "00000000-0000-0000-0000-000000000004",
    connector_type: "supabase",
    settings: {
      project_url: "https://catalog.example.com",
      schema: "public",
      rpc_allow_list: "agent_search_products",
      ...extra,
    },
    permissions: { search_products: true, check_stock: false, lookup_orders: false },
    read_only_mode: true,
  };
}

Deno.test("a connector with only the catalog function is not refused for having no table", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(rpcOnlyTool(), { query: "كريم الكعب" }, deps);

  assertEquals(errorCodeOf(result), undefined);
  assertEquals(calls.map(({ url, method }) => [new URL(url).pathname, method]), [
    ["/rest/v1/rpc/agent_search_products", "GET"],
  ]);
  assertEquals(argsOf(calls[0]), { q: "كريم الكعب", max_results: "8" });
  assertEquals(dataOf(result).row_count, 2);
});

Deno.test("the connection probe asks the function when the connector has no table", async () => {
  const { deps, calls } = recordingDeps([[]]);

  const result = await executeConnector(
    {
      tool: rpcOnlyTool(),
      credentials: { anon_key: ANON_KEY },
      request: { action: "test_connection", parameters: {} },
    },
    deps,
  );

  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(calls.map(({ url, method }) => [new URL(url).pathname, method]), [
    ["/rest/v1/rpc/agent_search_products", "GET"],
  ]);
  // One row, and a query no catalog holds: the probe reads nothing.
  assertEquals(argsOf(calls[0]), { q: "postora-connection-probe", max_results: "1" });
});

Deno.test("the operator's row ceiling caps the function's result count", async () => {
  const { deps, calls } = recordingDeps([FIXTURE]);

  const data = dataOf(await search(rpcOnlyTool({ max_rows: "2" }), { query: "heel" }, deps));

  assertEquals(argsOf(calls[0]), { q: "heel", max_results: "2" });
  assertEquals(data.row_count, 2);
});

Deno.test("the configured column restriction applies to the function's rows", async () => {
  const { deps } = recordingDeps([FIXTURE]);

  const rows = dataOf(
    await search(rpcOnlyTool({ select_columns: "name_ar,product_url" }), { query: "heel" }, deps),
  ).rows as Record<string, unknown>[];

  for (const row of rows) {
    assertEquals(Object.keys(row).sort(), ["name_ar", "product_url"]);
  }
});

Deno.test("a per-table column map applies to the function's rows too", async () => {
  const { deps } = recordingDeps([FIXTURE]);

  const rows = dataOf(
    await search(
      rpcOnlyTool({ column_map: JSON.stringify({ agent_catalog_products: ["product_url"] }) }),
      { query: "heel" },
      deps,
    ),
  ).rows as Record<string, unknown>[];

  for (const row of rows) {
    assertEquals(Object.keys(row), ["product_url"]);
  }
});

Deno.test("the catalog's product link is copied verbatim, never shortened", async () => {
  const longUrl = `https://curemedkw.com/brand/product/${"slug-".repeat(40)}`;
  const { deps } = recordingDeps([[{ product_url: longUrl, name_ar: "كريم" }]]);

  const rows = dataOf(await search(rpcOnlyTool(), { query: "heel" }, deps)).rows as Record<string, unknown>[];

  assertEquals(rows[0].product_url, longUrl);
  assertEquals(String(rows[0].product_url).includes("truncated"), false);
});

// ---------------------------------------------------------------------------
// The probe has to describe the search the connector actually runs.
// ---------------------------------------------------------------------------

Deno.test("the probe asks the function even when the connector may also read a table", async () => {
  // The catalog search uses the function, so a probe that only reads the table
  // reports success for a connector whose function is missing or misnamed, and
  // every search afterwards fails.
  const { deps, calls } = recordingDeps([[]]);

  const result = await executeConnector(
    {
      tool: catalogTool(),
      credentials: { anon_key: ANON_KEY },
      request: { action: "test_connection", parameters: {} },
    },
    deps,
  );

  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(calls.map(({ url, method }) => [new URL(url).pathname, method]), [
    ["/rest/v1/rpc/agent_search_products", "GET"],
    ["/rest/v1/agent_catalog_products", "GET"],
  ]);
});

Deno.test("a connector with only the function advertises only the capability it can run", async () => {
  // check_stock and lookup_orders read a table: an RPC-only connector has none, so
  // advertising them would promise calls that fail on their first use.
  const { deps } = recordingDeps([[]]);

  const result = await executeConnector(
    {
      tool: rpcOnlyTool(),
      credentials: { anon_key: ANON_KEY },
      request: { action: "test_connection", parameters: {} },
    },
    deps,
  );

  assertEquals(result.ok, true, JSON.stringify(result));
  assertEquals(result.ok && "capabilities" in result && result.capabilities, ["search_products"]);
});

Deno.test("a column list that will not parse fails the probe, not every search", async () => {
  const { deps, calls } = recordingDeps([[]]);

  const result = await executeConnector(
    {
      tool: rpcOnlyTool({ column_map: "{not json" }),
      credentials: { anon_key: ANON_KEY },
      request: { action: "test_connection", parameters: {} },
    },
    deps,
  );

  assertEquals(result.ok, false);
  assertEquals(result.ok === false && result.error.code, "supabase_column_map_invalid");
  assertEquals(calls.length, 0, "a configuration that cannot work is refused before any request");
});

Deno.test("a table list of several tables cannot say which one the function returns", async () => {
  // The first entry is not the catalog table by any rule the operator wrote, so the
  // restriction is refused rather than guessed.
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(
    catalogTool({
      rpc_allow_list: "agent_search_products",
      table_allow_list: "agent_catalog_products,agent_catalog_orders",
    }),
    { query: "heel" },
    deps,
  );

  assertEquals(errorCodeOf(result), "supabase_columns_unmapped");
  assertEquals(calls.length, 0);
});

Deno.test("a row the column list covers none of is not counted as a match", async () => {
  const { deps } = recordingDeps([FIXTURE]);

  const result = await search(
    rpcOnlyTool({ select_columns: "not_a_column" }),
    { query: "heel" },
    deps,
  );

  // Every row was projected away: the operator's list names no column the function
  // returns, and an empty result would read as "the catalog has nothing".
  assertEquals(errorCodeOf(result), "supabase_columns_unmapped");
});

Deno.test("count mode is refused for a function-backed search rather than answered with the row cap", async () => {
  // The function's result is capped at the operator's ceiling, so a count taken
  // from it would be that cap, not the number of matches.
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(rpcOnlyTool(), { query: "heel", mode: "count" }, deps);

  assertEquals(errorCodeOf(result), "supabase_count_unsupported");
  assertEquals(calls.length, 0);
});

// ---------------------------------------------------------------------------
// The review findings of 2026-11-13. Each test fails on the code it fixes:
// the restriction that was widened, the rows the wildcard emptied, the row
// that skipped the projection and the probe that outlived its budget.
// ---------------------------------------------------------------------------

Deno.test("a column map that names a table the allow-list excludes is refused, not widened", async () => {
  // The map says the function returns the rows of "orders" and allows every
  // column there, but the allow-list does not include that table. The
  // operator's table-scoped restriction has to hold: the map must not grant
  // the excluded table its columns.
  const { deps, calls } = recordingDeps([FIXTURE]);

  const result = await search(
    catalogTool({
      rpc_allow_list: "agent_search_products",
      column_map: JSON.stringify({ orders: "*" }),
    }),
    { query: "heel" },
    deps,
  );

  assertEquals(errorCodeOf(result), "supabase_resource_refused");
  assertEquals(calls.length, 0, "a configuration that cannot work is refused before any request");
});

Deno.test("a wildcard column list keeps every column the function returned", async () => {
  // "*" means "every column the row has". It is not a named allow-list, so it
  // must not be projected like one: a projection that kept only a field
  // literally named "*" emptied every ordinary row and answered "the catalog
  // has nothing".
  const { deps } = recordingDeps([FIXTURE]);

  const data = dataOf(await search(rpcOnlyTool({ select_columns: "*" }), { query: "heel" }, deps));

  assertEquals(data.row_count, 2);
  const rows = data.rows as Record<string, unknown>[];
  assertEquals(rows[0].name_ar, "كريم الكعب التجريبي");
  assertEquals(rows[0].product_url, "https://example.com/product/test-heel-cream");
});

Deno.test("a row that is not an object is refused when the operator named the columns", async () => {
  // A JSON array or a scalar has no field to keep, so it cannot be projected
  // onto the operator's column list. Passing it through would hand the model
  // whatever the function returned, outside the projection -- and the
  // structural redaction pass does not run for an operator-approved list.
  for (const row of [["a", "b"], "just a string", 42]) {
    const { deps } = recordingDeps([[row]]);

    const result = await search(rpcOnlyTool({ select_columns: "name_ar" }), { query: "heel" }, deps);

    assertEquals(errorCodeOf(result), "supabase_response_invalid");
  }
});

Deno.test("a row that is not an object passes when every column is allowed", async () => {
  // There is no projection to break, so the row is the data.
  const { deps } = recordingDeps([["just a string"]]);

  const result = await search(rpcOnlyTool({ select_columns: "*" }), { query: "heel" }, deps);

  assertEquals(errorCodeOf(result), undefined);
  assertEquals((dataOf(result).rows as unknown[])[0], "just a string");
});

Deno.test("the connection probe shares one deadline, so a hanging table probe cannot outlive the caller's budget", async () => {
  // The caller's budget covers the WHOLE adapter call, so the function probe
  // and the table probe share one deadline. The table probe's body never
  // ends: without the shared deadline the probe would never answer.
  const calls: Call[] = [];
  const deps: AdapterDependencies = {
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: null,
        headers: (init?.headers ?? {}) as Record<string, string>,
      });
      if (calls.length === 1) {
        // The function probe answers at once.
        return Promise.resolve(
          new Response("[]", { status: 200, headers: { "Content-Type": "application/json" } }),
        );
      }
      // The table probe answers with headers and a body that never ends.
      return Promise.resolve(
        new Response(
          new ReadableStream({ start() { /* never enqueues */ } }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    },
    timeoutMs: 1_000,
    maxRedirects: 3,
    callBudgetMs: 3_200,
    assertPublicHttpsUrl: (rawUrl) => Promise.resolve(new URL(rawUrl)),
    log: () => {},
  };

  const outcome = await Promise.race([
    executeConnector(
      {
        tool: catalogTool(),
        credentials: { anon_key: ANON_KEY },
        request: { action: "test_connection", parameters: {} },
      },
      deps,
    ).then((result) => ({ kind: "result" as const, result })),
    new Promise<{ kind: "timeout" }>((resolve) => setTimeout(() => resolve({ kind: "timeout" }), 3_000)),
  ]);

  assertEquals(outcome.kind, "result", "the probe must answer inside the caller's budget");
  if (outcome.kind !== "result") return;
  assertEquals(outcome.result.ok, false);
  assertEquals(errorCodeOf(outcome.result), "supabase_timeout");
  assertEquals(calls.length, 2, "the function probe and the table probe both ran");
});
