import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  FALLBACK_RATE_LIMITS,
  fetchGlobalSetting,
  fetchUserOverride,
  rateLimitKeyForPath,
  resolveRateLimit,
  type GlobalSettingRow,
  type RateLimitDeps,
  type UserOverrideRow,
} from "./rateLimitConfig.ts";

// deps with fixed rows; pass null to simulate "no row" and "rejecting" to
// simulate a database error.
function deps(user: UserOverrideRow | null | "rejecting", global: GlobalSettingRow | null | "rejecting"): RateLimitDeps {
  return {
    fetchUserOverride: () => (user === "rejecting" ? Promise.reject(new Error("override db down")) : Promise.resolve(user)),
    fetchGlobalSetting: () => (global === "rejecting" ? Promise.reject(new Error("settings db down")) : Promise.resolve(global)),
  };
}

const HOUR = 60 * 60 * 1000;

// --- Resolver priority order (every case asserts `source`, not just numbers) ---

Deno.test("live user override beats a global setting", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 50, window_minutes: 30, expires_at: null },
    { max_requests: 300, window_minutes: 60, is_active: true },
  ));
  assertEquals(result, { requests: 50, windowMs: 30 * 60_000, enforced: true, source: "user_override" });
});

Deno.test("expired override is ignored and the global setting applies", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 50, window_minutes: 30, expires_at: new Date(Date.now() - 1000).toISOString() },
    { max_requests: 300, window_minutes: 60, is_active: true },
  ));
  assertEquals(result, { requests: 300, windowMs: HOUR, enforced: true, source: "global_setting" });
});

Deno.test("a live user override outranks a disabled global setting", async () => {
  // The admin granted one user an explicit allowance — more specific than
  // "this endpoint is unmetered for everyone" (spec R2).
  const result = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 50, window_minutes: 30, expires_at: null },
    { max_requests: 300, window_minutes: 60, is_active: false },
  ));
  assertEquals(result, { requests: 50, windowMs: 30 * 60_000, enforced: true, source: "user_override" });
});

Deno.test("expired override plus disabled global means unmetered", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 50, window_minutes: 30, expires_at: new Date(Date.now() - 1000).toISOString() },
    { max_requests: 300, window_minutes: 60, is_active: false },
  ));
  assertEquals(result, { requests: 300, windowMs: HOUR, enforced: false, source: "global_setting" });
});

Deno.test("no override: the global setting applies with window_minutes converted to ms", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    null,
    { max_requests: 300, window_minutes: 45, is_active: true },
  ));
  assertEquals(result, { requests: 300, windowMs: 45 * 60_000, enforced: true, source: "global_setting" });
});

Deno.test("is_active = false on the global setting means enforced: false", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    null,
    { max_requests: 300, window_minutes: 60, is_active: false },
  ));
  assertEquals(result, { requests: 300, windowMs: HOUR, enforced: false, source: "global_setting" });
});

Deno.test("no rows at all resolves to the fallback map entry for a known endpoint", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(null, null));
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["/api/v1/post"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});

Deno.test("unknown endpoint resolves to the default fallback entry", async () => {
  const result = await resolveRateLimit("/api/v1/not-a-thing", deps(null, null));
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["default"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});

Deno.test("rejecting deps fall through to the fallback map without throwing", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps("rejecting", "rejecting"));
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["/api/v1/post"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});

Deno.test("malformed override (max_requests: 0) continues to the global setting, not straight to fallback", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 0, window_minutes: 60, expires_at: null },
    { max_requests: 300, window_minutes: 60, is_active: true },
  ));
  assertEquals(result, { requests: 300, windowMs: HOUR, enforced: true, source: "global_setting" });
});

Deno.test("malformed override window_minutes (0, negative, NaN) is skipped", async () => {
  for (const windowMinutes of [0, -5, NaN]) {
    const result = await resolveRateLimit("/api/v1/post", deps(
      { max_requests: 50, window_minutes: windowMinutes, expires_at: null },
      null,
    ));
    assertEquals(result.source, "fallback", `window_minutes ${windowMinutes} must skip the override`);
  }
});

Deno.test("malformed global row (max_requests: 0) falls through to the fallback map", async () => {
  const result = await resolveRateLimit("/api/v1/post", deps(
    null,
    { max_requests: 0, window_minutes: 60, is_active: true },
  ));
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["/api/v1/post"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});

Deno.test("expires_at boundaries: null and future are live, exactly-now is expired", async () => {
  // null: permanent override
  const permanent = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 10, window_minutes: 60, expires_at: null },
    null,
  ));
  assertEquals(permanent.source, "user_override");

  // future
  const future = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 10, window_minutes: 60, expires_at: new Date(Date.now() + 60_000).toISOString() },
    null,
  ));
  assertEquals(future.source, "user_override");

  // exactly now: "expires_at > now()" is false by the time the check runs
  // (time only moves forward), so the boundary counts as expired.
  const now = await resolveRateLimit("/api/v1/post", deps(
    { max_requests: 10, window_minutes: 60, expires_at: new Date().toISOString() },
    null,
  ));
  assertEquals(now.source, "fallback");
});

// --- Path normalization (spec R2a) ---

const UUID = "d41f6c78-3ac4-42b9-ae2c-7a5c7fa09dfb";

Deno.test("rateLimitKeyForPath covers every row of the spec R2a table", () => {
  assertEquals(rateLimitKeyForPath("/api/v1/media/upload", "POST"), "/api/v1/upload-media");
  assertEquals(rateLimitKeyForPath("/api/v1/webhooks/test", "POST"), "/api/v1/webhooks");
  assertEquals(rateLimitKeyForPath(`/api/v1/webhooks/${UUID}`, "DELETE"), "/api/v1/webhooks");
  assertEquals(rateLimitKeyForPath(`/api/v1/media/${UUID}`, "GET"), "/api/v1/media");
  // A single-post read shares the /api/v1/posts READ budget, never the
  // /api/v1/post write budget — the difference between 300/hr and 60/hr.
  assertEquals(rateLimitKeyForPath(`/api/v1/post/${UUID}`, "GET"), "/api/v1/posts");
  assertEquals(rateLimitKeyForPath(`/api/v1/post/${UUID}`, "GET") !== "/api/v1/post", true);
});

Deno.test("rateLimitKeyForPath passes canonical paths and unknown paths through unchanged", () => {
  for (const canonical of Object.keys(FALLBACK_RATE_LIMITS)) {
    if (canonical === "default") continue;
    assertEquals(rateLimitKeyForPath(canonical, "GET"), canonical);
    assertEquals(rateLimitKeyForPath(canonical, "POST"), canonical);
  }
  assertEquals(rateLimitKeyForPath("/api/v1/not-a-thing", "GET"), "/api/v1/not-a-thing");
  assertEquals(rateLimitKeyForPath("/api/v1/webhooks/test/extra", "POST"), "/api/v1/webhooks/test/extra");
});

Deno.test("a path matched with the wrong method keeps its raw path and never bills a real budget", () => {
  // The router pairs each of these paths with exactly one method, so any other
  // method is a 404. Mapping it anyway would let an unroutable request eat a
  // quota it can never spend — e.g. POST /api/v1/post/<id> consuming the
  // 300/hr list-posts budget.
  assertEquals(rateLimitKeyForPath(`/api/v1/post/${UUID}`, "POST"), `/api/v1/post/${UUID}`);
  assertEquals(rateLimitKeyForPath(`/api/v1/post/${UUID}`, "DELETE"), `/api/v1/post/${UUID}`);
  assertEquals(rateLimitKeyForPath(`/api/v1/media/${UUID}`, "POST"), `/api/v1/media/${UUID}`);
  assertEquals(rateLimitKeyForPath(`/api/v1/webhooks/${UUID}`, "GET"), `/api/v1/webhooks/${UUID}`);

  // These two are NOT wrong-method cases, and both still map — the router does
  // route them, just to a different handler than the path's name suggests:
  //   GET    /api/v1/media/upload  -> handleGetMediaById with the id "upload"
  //   DELETE /api/v1/webhooks/test -> handleDeleteWebhook with the id "test"
  // Each therefore belongs on its family's budget, which is what these assert.
  assertEquals(rateLimitKeyForPath("/api/v1/media/upload", "GET"), "/api/v1/media");
  assertEquals(rateLimitKeyForPath("/api/v1/webhooks/test", "DELETE"), "/api/v1/webhooks");

  // And an unmapped path resolves to the default budget, not to a real one.
  const unroutable = rateLimitKeyForPath(`/api/v1/post/${UUID}`, "POST");
  assertEquals(FALLBACK_RATE_LIMITS[unroutable], undefined);
});

// --- Supabase adapters (stub client: assert the filters actually passed) ---

interface FilterCall {
  table: string;
  column: string;
  value: unknown;
}

function stubSupabase(result: { data: unknown; error?: { message: string } | null }) {
  const filterCalls: FilterCall[] = [];
  let selectArg = "";
  let table = "";
  const chain: any = {
    select: (columns: string) => {
      selectArg = columns;
      return chain;
    },
    eq: (column: string, value: unknown) => {
      filterCalls.push({ table, column, value });
      return chain;
    },
    maybeSingle: () => Promise.resolve(result),
  };
  const client = {
    from: (name: string) => {
      table = name;
      return chain;
    },
  };
  return { client, filterCalls, getSelect: () => selectArg };
}

Deno.test("fetchUserOverride queries user_rate_limits with the user_id and endpoint filters", async () => {
  const row = { max_requests: 50, window_minutes: 30, expires_at: null };
  const { client, filterCalls, getSelect } = stubSupabase({ data: row });

  const result = await fetchUserOverride(client, "user-123", "/api/v1/post");

  assertEquals(result, row);
  assertEquals(filterCalls, [
    { table: "user_rate_limits", column: "user_id", value: "user-123" },
    { table: "user_rate_limits", column: "endpoint", value: "/api/v1/post" },
  ]);
  assertEquals(getSelect().includes("expires_at"), true);
});

Deno.test("fetchGlobalSetting queries rate_limit_settings with the endpoint filter", async () => {
  const row = { max_requests: 300, window_minutes: 60, is_active: true };
  const { client, filterCalls, getSelect } = stubSupabase({ data: row });

  const result = await fetchGlobalSetting(client, "/api/v1/post");

  assertEquals(result, row);
  assertEquals(filterCalls, [{ table: "rate_limit_settings", column: "endpoint", value: "/api/v1/post" }]);
  assertEquals(getSelect().includes("is_active"), true);
});

Deno.test("an { data: null, error } response is surfaced as a rejection the resolver falls through on", async () => {
  const { client } = stubSupabase({ data: null, error: { message: "connection refused" } });

  await assertRejects(() => fetchUserOverride(client, "user-123", "/api/v1/post"), Error, "connection refused");
  await assertRejects(() => fetchGlobalSetting(client, "/api/v1/post"), Error, "connection refused");

  // Wired through the resolver, the same rejection degrades to the fallback
  // rather than becoming a 5xx (Cloudflare masks origin 5xx on this deployment).
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => fetchUserOverride(client, "user-123", "/api/v1/post"),
    fetchGlobalSetting: () => fetchGlobalSetting(client, "/api/v1/post"),
  });
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["/api/v1/post"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});
