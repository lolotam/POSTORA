import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { readCacheKey, TurnReadCache, type ReadCacheScope } from "./turnReadCache.ts";
import type { CustomTool, ToolResult } from "./tools.ts";

const SCOPE: ReadCacheScope = {
  userId: "owner",
  socialAccountId: "account",
  platform: "whatsapp",
  conversationId: "conversation",
  threadId: "thread",
  dryRun: false,
};
const WOO: CustomTool = {
  id: "tool-1",
  name: "catalog",
  description: "catalog",
  url: "https://example.test",
  secret: null,
  admin_only: false,
  connector_type: "woocommerce",
  read_only_mode: true,
};
const ARGS = { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true } } };
const SUCCESS: ToolResult = { output: "fresh result", readOutcome: "success" };

function execution(args: unknown = ARGS, overrides: {
  name?: string;
  argumentsValid?: boolean;
  customTool?: CustomTool;
  scope?: ReadCacheScope;
} = {}) {
  return {
    name: overrides.name ?? "catalog",
    args,
    argumentsValid: overrides.argumentsValid ?? true,
    customTool: Object.hasOwn(overrides, "customTool") ? overrides.customTool : WOO,
    scope: overrides.scope ?? SCOPE,
  };
}

Deno.test("recursively reordered object keys reuse one successful read without changing it", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  const run = () => { calls++; return Promise.resolve(SUCCESS); };
  const first = await cache.execute(execution(), run);
  const second = await cache.execute(execution({
    parameters: { filters: { inStock: true }, query: "Cream" }, capability: "search_products",
  }), run);
  assertEquals(calls, 1);
  assertEquals(first, SUCCESS);
  assertEquals(second, SUCCESS);
  assertEquals(cache.stats, { cache_hits: 1, cache_misses: 1, cache_coalesced: 0, cache_errors: 0 });
});

Deno.test("different variants, filters, arrays, types, null and missing fields never merge", async () => {
  const variants = [
    ARGS,
    { capability: "search_products", parameters: { query: "cream", filters: { inStock: true } } },
    { capability: "search_products", parameters: { query: "Cream ", filters: { inStock: true } } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: false } } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true }, order: ["a", "b"] } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true }, order: ["b", "a"] } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true }, limit: 1 } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true }, limit: "1" } },
    { capability: "search_products", parameters: { query: "Cream", filters: { inStock: true }, limit: null } },
  ];
  const keys = variants.map((args) => readCacheKey(execution(args)));
  assert(keys.every((key) => key !== null));
  assertEquals(new Set(keys).size, variants.length);
});

Deno.test("tool, account, conversation, sandbox and invocation identity stay isolated", async () => {
  const otherTool = { ...WOO, id: "tool-2" };
  const keys = [
    readCacheKey(execution()),
    readCacheKey(execution(ARGS, { customTool: otherTool })),
    readCacheKey(execution(ARGS, { scope: { ...SCOPE, socialAccountId: "other-account" } })),
    readCacheKey(execution(ARGS, { scope: { ...SCOPE, conversationId: "other-conversation" } })),
    readCacheKey(execution(ARGS, { scope: { ...SCOPE, threadId: "other-thread" } })),
    readCacheKey(execution(ARGS, { scope: { ...SCOPE, dryRun: true } })),
  ];
  assertEquals(new Set(keys).size, keys.length);

  let calls = 0;
  const first = new TurnReadCache();
  await first.execute(execution(), () => { calls++; return Promise.resolve(SUCCESS); });
  const second = new TurnReadCache();
  await second.execute(execution(), () => { calls++; return Promise.resolve(SUCCESS); });
  assertEquals(calls, 2);
});

Deno.test("concurrent exact duplicates coalesce and each caller receives an independent result", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async () => { calls++; await gate; return { ...SUCCESS, retrievedChunkIds: ["chunk"] }; };
  const first = cache.execute(execution(), run);
  const second = cache.execute(execution({
    capability: "search_products",
    parameters: { filters: { inStock: true }, query: "Cream" },
  }), run);
  release();
  const [left, right] = await Promise.all([first, second]);
  assertEquals(calls, 1);
  assertEquals(left, right);
  assert(left !== right);
  assertEquals(cache.stats.cache_coalesced, 1);
});

Deno.test("successful empty results cache; errors, absent metadata and throws never become empty success", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  const empty = { output: "No matching business knowledge found.", retrievedChunkIds: [], readOutcome: "success" as const };
  await cache.execute(execution(), () => { calls++; return Promise.resolve(empty); });
  await cache.execute(execution(), () => { calls++; return Promise.resolve(empty); });
  assertEquals(calls, 1);

  const failures = new TurnReadCache();
  let attempts = 0;
  const outcomes: Array<() => Promise<ToolResult>> = [
    () => Promise.resolve({ output: "temporarily unavailable", readOutcome: "error" }),
    () => Promise.resolve({ output: "legacy result without typed proof" }),
    () => Promise.reject(new Error("transport failed")),
    () => Promise.resolve({ output: "recovered", readOutcome: "success" }),
  ];
  for (const outcome of outcomes) {
    try {
      await failures.execute(execution(), () => { attempts++; return outcome(); });
    } catch { /* the rejection is intentionally retried below */ }
  }
  assertEquals(attempts, 4);
  assertEquals(failures.stats.cache_errors, 2);
});

Deno.test("failed concurrent reads share the current error and a later call executes again", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const run = async (): Promise<ToolResult> => {
    calls++;
    if (calls > 1) return { output: "recovered", readOutcome: "success" };
    await gate;
    return { output: "failed", readOutcome: "error" };
  };
  const first = cache.execute(execution(), run);
  const second = cache.execute(execution(), run);
  release();
  assertEquals((await first).readOutcome, "error");
  assertEquals((await second).readOutcome, "error");
  assertEquals((await cache.execute(execution(), run)).output, "recovered");
  assertEquals(calls, 2);
});

Deno.test("a thrown execution evicts its in-flight entry", async () => {
  const cache = new TurnReadCache();
  await assertRejects(() => cache.execute(execution(), () => Promise.reject(new Error("failed"))));
  await assertRejects(() => cache.execute(execution(), () => { throw new Error("synchronous failure"); }));
  const result = await cache.execute(execution(), () => Promise.resolve(SUCCESS));
  assertEquals(result, SUCCESS);
  assertEquals(cache.stats.cache_misses, 3);
  assertEquals(cache.stats.cache_errors, 2);
});

Deno.test("invalid or unsupported arguments bypass reuse and retain executor validation", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  const run = () => { calls++; return Promise.resolve(SUCCESS); };
  await cache.execute(execution(ARGS, { argumentsValid: false }), run);
  await cache.execute(execution([], {}), run);
  await cache.execute(execution({ ...ARGS, unsupported: undefined }), run);
  await cache.execute(execution({ ...ARGS, unsupported: Number.POSITIVE_INFINITY }), run);
  assertEquals(calls, 4);
});

Deno.test("mutation invalidation forces a fresh read", async () => {
  const cache = new TurnReadCache();
  let calls = 0;
  const run = () => { calls++; return Promise.resolve(SUCCESS); };
  await cache.execute(execution(), run);
  cache.invalidate();
  await cache.execute(execution(), run);
  assertEquals(calls, 2);
});

Deno.test("an invalidated in-flight result cannot replace or coalesce with the fresh read", async () => {
  const cache = new TurnReadCache();
  let releaseOld!: () => void;
  const oldGate = new Promise<void>((resolve) => { releaseOld = resolve; });
  const oldRead = cache.execute(execution(), async () => {
    await oldGate;
    return { output: "before action", readOutcome: "success" };
  });
  cache.invalidate();
  let freshCalls = 0;
  const fresh = () => {
    freshCalls++;
    return Promise.resolve({ output: "after action", readOutcome: "success" as const });
  };
  assertEquals((await cache.execute(execution(), fresh)).output, "after action");
  releaseOld();
  assertEquals((await oldRead).output, "before action");
  assertEquals((await cache.execute(execution(), fresh)).output, "after action");
  assertEquals(freshCalls, 1);
});

Deno.test("only native knowledge and registered catalog reads are eligible", () => {
  assert(readCacheKey(execution({ query: "policy" }, { name: "search_knowledge", customTool: undefined })) !== null);
  for (const capability of ["search_products", "get_product", "check_stock"]) {
    assert(readCacheKey(execution({ capability, parameters: {} })) !== null);
  }
  assert(readCacheKey(execution(ARGS, {
    customTool: { ...WOO, connector_type: "supabase", read_only_mode: true },
  })) !== null);
  const excluded: CustomTool[] = [
    { ...WOO, name: "search_knowledge", connector_type: "custom_rest" },
    { ...WOO, connector_type: "custom_rest" },
    { ...WOO, auth_strategy: "composio_oauth" },
    { ...WOO, read_only_mode: false, connector_type: "supabase" },
  ];
  for (const customTool of excluded) assertEquals(readCacheKey(execution(ARGS, { customTool })), null);
  assertEquals(readCacheKey(execution(ARGS, {
    name: "search_knowledge",
    customTool: { ...WOO, name: "search_knowledge", connector_type: "custom_rest" },
  })), null);
  for (const capability of ["update_order", "lookup_orders", "execute_rpc", "list_records"]) {
    assertEquals(readCacheKey(execution({ capability, parameters: {} })), null);
  }
  for (const name of ["stock_waitlist_join", "escalate_to_human", "notify_admin", "procedure_submit", "web_search"]) {
    assertEquals(readCacheKey(execution({}, { name, customTool: undefined })), null);
  }
});
