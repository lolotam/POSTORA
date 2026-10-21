import { assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  FALLBACK_RATE_LIMITS,
  fetchGlobalSetting,
  fetchPlanSlug,
  fetchTierLimit,
  fetchUserOverride,
  rateLimitKeyForPath,
  resolveRateLimit,
  type GlobalSettingRow,
  type RateLimitDeps,
  type UserOverrideRow,
} from "./rateLimitConfig.ts";

// deps with fixed rows; pass null to simulate "no row" and "rejecting" to
// simulate a database error. The tier step defaults to no plan, which skips
// it: these tests pin the override/global/fallback relationships, and the
// tier step has its own tests below.
function deps(user: UserOverrideRow | null | "rejecting", global: GlobalSettingRow | null | "rejecting"): RateLimitDeps {
  return {
    fetchUserOverride: () => (user === "rejecting" ? Promise.reject(new Error("override db down")) : Promise.resolve(user)),
    fetchPlanSlug: () => Promise.resolve(null),
    fetchTierLimit: () => Promise.resolve(null),
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

interface OrderCall {
  column: string;
  opts: unknown;
}

function stubSupabase(result: { data: unknown; error?: { message: string } | null }) {
  const filterCalls: FilterCall[] = [];
  const orderCalls: OrderCall[] = [];
  const limitCalls: number[] = [];
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
    // Mirrors the arbiter's IN(...) entitlement predicate (C1, 2026-08-23
    // final review) — recorded as a filter call so callers can assert it the
    // same way as .eq().
    in: (column: string, values: unknown) => {
      filterCalls.push({ table, column, value: values });
      return chain;
    },
    order: (column: string, opts: unknown) => {
      orderCalls.push({ column, opts });
      return chain;
    },
    limit: (n: number) => {
      limitCalls.push(n);
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
  return { client, filterCalls, orderCalls, limitCalls, getSelect: () => selectArg };
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
    fetchPlanSlug: () => Promise.resolve(null),
    fetchTierLimit: () => Promise.resolve(null),
    fetchGlobalSetting: () => fetchGlobalSetting(client, "/api/v1/post"),
  });
  assertEquals(result, { requests: FALLBACK_RATE_LIMITS["/api/v1/post"].requests, windowMs: HOUR, enforced: true, source: "fallback" });
});

// --- Tier limits (resolution step between the user override and the global) ---

Deno.test("resolveRateLimit prefers a user override over a tier row", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve({ max_requests: 5, window_minutes: 60, expires_at: null }),
    fetchPlanSlug: () => Promise.resolve("pro"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 999, max_requests_per_day: 9999, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve(null),
  });
  assertEquals(result.requests, 5);
  assertEquals(result.source, "user_override");
});

Deno.test("resolveRateLimit prefers a tier row over the global setting", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 12, max_requests_per_day: 100, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 12);
  assertEquals(result.windowMs, 60 * 60 * 1000);
  assertEquals(result.source, "tier_limit");
});

Deno.test("resolveRateLimit skips an inactive tier row and falls through", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 12, max_requests_per_day: 100, is_active: false }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "global_setting");
});

Deno.test("resolveRateLimit skips a malformed tier row", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 0, max_requests_per_day: 100, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "global_setting");
});

Deno.test("resolveRateLimit degrades to the fallback map when the plan lookup throws", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.reject(new Error("db down")),
    fetchTierLimit: () => Promise.resolve(null),
    fetchGlobalSetting: () => Promise.resolve(null),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "fallback");
});

Deno.test("resolveRateLimit degrades to the global setting when the plan lookup throws", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.reject(new Error("db down")),
    fetchTierLimit: () => { throw new Error("must not be called"); },
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 60);
  assertEquals(result.source, "global_setting");
});

// Amendment A7, inverted from the drafted version: a caller with no active
// subscription is a FREE user, not a plan-less one. fetchPlanSlug resolves
// 'free' for the missing-row case (asserted against the stub client below),
// so the tier step runs for exactly the population free limits constrain, and
// the free tier row outranks the global setting.
Deno.test("a caller with no active subscription resolves 'free', and its tier row outranks the global setting", async () => {
  const result = await resolveRateLimit("/api/v1/post", {
    fetchUserOverride: () => Promise.resolve(null),
    fetchPlanSlug: () => Promise.resolve("free"),
    fetchTierLimit: () => Promise.resolve({ max_requests_per_hour: 15, max_requests_per_day: 360, is_active: true }),
    fetchGlobalSetting: () => Promise.resolve({ max_requests: 60, window_minutes: 60, is_active: true }),
  });
  assertEquals(result.requests, 15);
  assertEquals(result.windowMs, HOUR);
  assertEquals(result.source, "tier_limit");
});

Deno.test("fetchPlanSlug returns the active subscription's plan slug", async () => {
  const { client, filterCalls, getSelect } = stubSupabase({ data: { subscription_plans: { slug: "pro" } } });

  const result = await fetchPlanSlug(client, "user-123");

  assertEquals(result, "pro");
  assertEquals(filterCalls, [
    { table: "user_subscriptions", column: "user_id", value: "user-123" },
    { table: "user_subscriptions", column: "status", value: ["active", "past_due"] },
  ]);
  assertEquals(getSelect().includes("subscription_plans(slug)"), true);
});

// C1 (final review, 2026-08-23): dunning must not drop a paying customer's
// rate-limit tier to free. past_due now entitles like active, matching
// effective_user_quotas() exactly.
Deno.test("fetchPlanSlug returns the plan slug for a past_due (dunning) subscription", async () => {
  const { client, filterCalls } = stubSupabase({ data: { subscription_plans: { slug: "business" } } });

  const result = await fetchPlanSlug(client, "user-123");

  assertEquals(result, "business");
  assertEquals(
    filterCalls.some((c) => c.column === "status" && Array.isArray(c.value) && (c.value as string[]).includes("past_due")),
    true,
  );
});

// The maybeSingle trap: filtering on IN(...) instead of a single .eq() can
// return more than one row for a user with both an active and a past_due
// subscription. Without the ORDER BY + LIMIT 1 tie-break (mirroring the SQL
// arbiter's own three-part tie-break), maybeSingle() would throw on two rows
// and this function would silently fall through to 'free' — the exact
// downgrade this fix exists to prevent.
Deno.test("fetchPlanSlug orders by the arbiter's tie-break and limits to one row", async () => {
  const { client, orderCalls, limitCalls } = stubSupabase({ data: { subscription_plans: { slug: "pro" } } });

  await fetchPlanSlug(client, "user-123");

  assertEquals(orderCalls, [
    { column: "current_period_end", opts: { ascending: false, nullsFirst: false } },
    { column: "created_at", opts: { ascending: false } },
    { column: "id", opts: { ascending: false } },
  ]);
  assertEquals(limitCalls, [1]);
});

Deno.test("fetchPlanSlug resolves 'free' when there is no active subscription row", async () => {
  // Amendment A7: most free users have no user_subscriptions row at all, so a
  // NULL here would skip the tier step for exactly the users the free tier
  // limits are meant to constrain.
  const { client } = stubSupabase({ data: null });

  const result = await fetchPlanSlug(client, "user-123");

  assertEquals(result, "free");
});

Deno.test("fetchTierLimit queries tier_rate_limits with the plan_slug and endpoint filters", async () => {
  const row = { max_requests_per_hour: 120, max_requests_per_day: 2880, is_active: true };
  const { client, filterCalls, getSelect } = stubSupabase({ data: row });

  const result = await fetchTierLimit(client, "pro", "/api/v1/post");

  assertEquals(result, row);
  assertEquals(filterCalls, [
    { table: "tier_rate_limits", column: "plan_slug", value: "pro" },
    { table: "tier_rate_limits", column: "endpoint", value: "/api/v1/post" },
  ]);
  assertEquals(getSelect().includes("max_requests_per_hour"), true);
});

Deno.test("the MCP post-management routes have their own budgets, destructive ones capped at 60/h", () => {
  for (const key of ["/api/v1/posts/cancel", "/api/v1/posts/delete"]) {
    assertEquals(FALLBACK_RATE_LIMITS[key].requests, 60);
    assertEquals(rateLimitKeyForPath(key, "POST"), key);
  }
  assertEquals(rateLimitKeyForPath("/api/v1/accounts/health", "GET"), "/api/v1/accounts/health");
  assertEquals(FALLBACK_RATE_LIMITS["/api/v1/best-times"].requests, 30);
});
