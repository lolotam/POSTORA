import { assertEquals, assertNotEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { FALLBACK_RATE_LIMITS, type ResolvedRateLimit } from "./rateLimitConfig.ts";
// index.ts binds its port via Deno.serve only when run as the main module, so
// this import stays side-effect free and the tests below exercise the real
// production functions — never a mock of the module under test.
import { checkRateLimit, handleRequest, withRateLimitHeaders } from "./index.ts";

const HOUR = 60 * 60 * 1000;

/**
 * Stub of the Supabase client boundary — the only thing stubbed here. The
 * metered count query is `from('api_logs').select(...).eq(...).is(...).gte(...)`
 * awaited as a thenable, and `insert` returns a plain result promise.
 */
/** The query builder the rate limiter calls: chainable filters, awaitable as the count result. */
interface ApiLogsChain {
  select(columns: string, opts: unknown): ApiLogsChain;
  eq(column: string, value: unknown): ApiLogsChain;
  is(column: string, value: unknown): ApiLogsChain;
  gte(column: string, value: unknown): ApiLogsChain;
  then(onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown): Promise<unknown>;
  insert(row: Record<string, unknown>): Promise<{ error: null }>;
}

function stubApiLogs(countResult: { count: number | null; error?: { message: string } | null }) {
  const countFilters: Array<{ table: string; column: string; value: unknown }> = [];
  const inserts: Array<Record<string, unknown>> = [];
  const tables: string[] = [];
  const chain: ApiLogsChain = {
    select: (_columns: string, _opts: unknown) => chain,
    eq: (column: string, value: unknown) => {
      countFilters.push({ table: tables[tables.length - 1], column, value });
      return chain;
    },
    is: (column: string, value: unknown) => {
      countFilters.push({ table: tables[tables.length - 1], column, value });
      return chain;
    },
    gte: (column: string, value: unknown) => {
      countFilters.push({ table: tables[tables.length - 1], column, value });
      return chain;
    },
    then: (onFulfilled?: (value: unknown) => unknown, onRejected?: (reason: unknown) => unknown) =>
      Promise.resolve(countResult).then(onFulfilled, onRejected),
    insert: (row: Record<string, unknown>) => {
      inserts.push(row);
      return Promise.resolve({ error: null });
    },
  };
  const client = {
    from: (table: string) => {
      tables.push(table);
      return chain;
    },
  };
  return { client, countFilters, inserts };
}

Deno.test("enforced: false skips the count query and writes the unmetered marker", async () => {
  const { client, countFilters, inserts } = stubApiLogs({ count: 999, error: null });
  // 999 counted rows must not matter: the count query is never issued.
  const result = await checkRateLimit(client, "user-1", "/api/v1/webhooks", "POST", null, {
    requests: 300,
    windowMs: HOUR,
    enforced: false,
    source: "global_setting",
  });

  assertEquals(countFilters.length, 0);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].request_data, { rate_limit: "unmetered" });
  assertEquals(inserts[0].status_code, 200);
  assertEquals(result.allowed, true);
  assertEquals(result.remaining, 300);
});

Deno.test("the metered path counts with .is('request_data', null) and leaves metered rows null", async () => {
  const { client, countFilters, inserts } = stubApiLogs({ count: 5, error: null });
  const result = await checkRateLimit(client, "user-1", "/api/v1/post", "POST", "1.2.3.4", {
    requests: 60,
    windowMs: HOUR,
    enforced: true,
    source: "user_override",
  });

  // The exclusion filter is the whole point: without it, traffic logged while a
  // limit was disabled throttles users the moment an admin re-enables it.
  assertEquals(countFilters.slice(0, 3), [
    { table: "api_logs", column: "user_id", value: "user-1" },
    { table: "api_logs", column: "endpoint", value: "/api/v1/post" },
    { table: "api_logs", column: "request_data", value: null },
  ]);
  assertEquals(countFilters[3]?.column, "created_at");
  assertEquals(typeof countFilters[3]?.value, "string");

  assertEquals(result.allowed, true);
  assertEquals(result.remaining, 55);
  // Metered rows keep request_data null so the count filter stays exact.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].request_data, undefined);
});

Deno.test("resetAt is strictly in the future on both paths", async () => {
  const meteredBefore = Date.now();
  const metered = await checkRateLimit(stubApiLogs({ count: 0, error: null }).client, "u", "/api/v1/post", "POST", null, {
    requests: 60,
    windowMs: HOUR,
    enforced: true,
    source: "fallback",
  });
  // The old windowStart + windowMs evaluated to exactly "now"; the fixed value
  // is now + window, a conservative upper bound on the rolling reset.
  assertEquals(metered.resetAt.getTime() >= meteredBefore + HOUR, true);
  assertEquals(metered.resetAt.getTime() <= Date.now() + HOUR, true);

  const unmeteredBefore = Date.now();
  const unmetered = await checkRateLimit(stubApiLogs({ count: 0, error: null }).client, "u", "/api/v1/post", "POST", null, {
    requests: 60,
    windowMs: HOUR,
    enforced: false,
    source: "global_setting",
  });
  assertEquals(unmetered.resetAt.getTime() >= unmeteredBefore + HOUR, true);
});

Deno.test("withRateLimitHeaders reports the resolved limit, which differs from the fallback map", () => {
  const endpoint = "/api/v1/post";
  const fallback = FALLBACK_RATE_LIMITS[endpoint];
  // Because the seeds equal the fallback numbers, a header helper that did its
  // own lookup would pass every smoke test. Reporting a value that provably
  // differs from the map is the one assertion that catches a self-lookup.
  const resolved: ResolvedRateLimit = {
    requests: fallback.requests + 1234,
    windowMs: fallback.windowMs,
    enforced: true,
    source: "user_override",
  };
  const resetAt = new Date("2030-01-01T00:00:00Z");

  const response = withRateLimitHeaders(new Response("ok"), { remaining: 7, resetAt }, resolved);

  assertEquals(response.headers.get("X-RateLimit-Limit"), String(fallback.requests + 1234));
  assertNotEquals(response.headers.get("X-RateLimit-Limit"), String(fallback.requests));
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "7");
  assertEquals(response.headers.get("X-RateLimit-Reset"), resetAt.toISOString());
});

Deno.test("withRateLimitHeaders reports the resolved value as both limit and remaining when unmetered", () => {
  const response = withRateLimitHeaders(
    new Response(null),
    { remaining: 300, resetAt: new Date("2030-01-01T00:00:00Z") },
    { requests: 300, windowMs: HOUR, enforced: false, source: "global_setting" },
  );
  assertEquals(response.headers.get("X-RateLimit-Limit"), "300");
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "300");
  assertEquals(response.status, 200);
});

// Source-level regression tripwires, not integration tests. A real in-process
// router test would need index.ts restructured away from a top-level
// Deno.serve, which is riskier than the gap it closes (spec §6, Codex r2 #3);
// the authoritative end-to-end proof is the post-deploy live check. These use
// Function.prototype.toString() on the live exported functions, which inspects
// the exact shipped code rather than a copy of the file text.
Deno.test("tripwire: the router resolves the canonical rate-limit key via rateLimitKeyForPath", () => {
  const routerSource = handleRequest.toString();
  assertEquals(routerSource.includes("rateLimitKeyForPath("), true);
});

Deno.test("tripwire: withRateLimitHeaders performs no lookup of its own", () => {
  // Also catches FALLBACK_RATE_LIMITS[...], which contains this substring.
  const helperSource = withRateLimitHeaders.toString();
  assertEquals(helperSource.includes("RATE_LIMITS["), false);
});

// The 429 branch returns before the router reaches withRateLimitHeaders, so it
// needs its own wrapping. A throttled client is precisely the one that has to
// read X-RateLimit-Reset to know when to retry, and it was the only response
// shape shipping without those headers.
Deno.test("a 429 response carries the rate limit headers", () => {
  const resetAt = new Date("2030-01-01T00:00:00Z");
  const config: ResolvedRateLimit = { requests: 600, windowMs: HOUR, enforced: true, source: "global_setting" };
  const throttled = new Response(JSON.stringify({ error: "Too many requests" }), {
    status: 429,
    headers: { "Content-Type": "application/json" },
  });

  const response = withRateLimitHeaders(throttled, { remaining: 0, resetAt }, config);

  assertEquals(response.status, 429);
  assertEquals(response.headers.get("X-RateLimit-Limit"), "600");
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "0");
  assertEquals(response.headers.get("X-RateLimit-Reset"), resetAt.toISOString());
  // Wrapping must not drop the headers the error response already carried.
  assertEquals(response.headers.get("Content-Type"), "application/json");
});

Deno.test("tripwire: the router wraps its 429 response in withRateLimitHeaders", () => {
  // Guards the early-return path the other tests cannot reach: the router
  // returns before route handling when a limit is exceeded, so a future edit
  // could drop the wrap without failing any behavioural test above.
  const routerSource = handleRequest.toString();
  const throttleBranch = routerSource.slice(routerSource.indexOf("RATE_LIMIT_EXCEEDED") - 400);
  assertEquals(throttleBranch.includes("withRateLimitHeaders("), true);
});
