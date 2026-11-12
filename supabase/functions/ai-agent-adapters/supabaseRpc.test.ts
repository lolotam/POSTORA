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

interface Call { url: string; method: string; body: unknown }

function recordingDeps(answers: unknown[][]): { deps: AdapterDependencies; calls: Call[] } {
  const calls: Call[] = [];
  const deps: AdapterDependencies = {
    fetch: (url, init) => {
      calls.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : null,
      });
      const rows = answers[Math.min(calls.length - 1, answers.length - 1)];
      return Promise.resolve(
        new Response(JSON.stringify(rows), { status: 200, headers: { "Content-Type": "application/json" } }),
      );
    },
    timeoutMs: 1_000,
    maxRedirects: 3,
    assertPublicHttpsUrl: (rawUrl) => Promise.resolve(new URL(rawUrl)),
    log: () => {},
  };
  return { deps, calls };
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
    ["/rest/v1/rpc/agent_search_products", "POST"],
  ]);
  assertEquals(calls[0].body, { q: "كريم الكعب", max_results: 8 });
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
    assertEquals(calls[0].body, { term: "heel", lim: sent }, `max_results ${String(asked)}`);
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

  assertEquals(calls.map((call) => call.body), [
    { q: "كريم للكعب المتشقق", max_results: 8 },
    { q: "المتشقق", max_results: 8 },
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

  assertEquals(calls[0].body, { q: "heel", max_results: 8 });
});
