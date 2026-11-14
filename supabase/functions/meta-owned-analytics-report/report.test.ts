import { assertEquals, assertRejects, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { closedAnalyticsPeriods } from "../_shared/analyticsCalendar.ts";
import { analyticsDefinitions } from "../_shared/analyticsRegistry.ts";
import { assembleStoredAnalytics } from "./assemble.ts";
import { storedReportCursor, storedReportPosition, type StoredReportScope } from "./cursor.ts";
import { createStoredReportHandler } from "./handler.ts";
import { PersistedReportRefused, readStoredAnalytics, type StoredAnalyticsSnapshot } from "./store.ts";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";

const OWNER = "d1000000-0000-4000-8000-000000000001";
const ACCOUNT = "d2000000-0000-4000-8000-000000000001";
const NOW = "2026-11-01T12:00:00.000Z";
const COLLECTED = "2026-11-01T10:00:00.000Z";
const scope: StoredReportScope = { platform: "facebook", ownerId: OWNER, accountId: ACCOUNT, days: 7 };
const windows = closedAnalyticsPeriods({ now: NOW, days: 7, timezone: "America/Los_Angeles" });

Deno.test("live readiness does not erase a real provider permission failure from dated sync history", () => {
  const stored = fixture();
  stored.collection.latest = { ...stored.collection.latest!, state: "failed", reason_code: "permission_missing" };
  stored.readiness = {
    collection: { contract_version: 2, state: "syncing", reason_code: "awaiting_first_capture", reason_source: "data",
      observed_at: NOW, next_action: "wait", reconnect_can_help: false, retry_at: null, support_correlation_id: "fixture-correlation" },
    connection: { state: "verified", reason_code: null }, permission: { state: "verified", observed_at: COLLECTED, missing_scopes: [] }, last_attempt: null,
  };
  const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(report.sync.reason, "permission_missing");
});

Deno.test("provider permission refusal without named scopes requires its dated job proof", () => {
  const stored = fixture();
  const readiness = {
    collection: { contract_version: 2, state: "permissions_missing", reason_code: "permission_missing", reason_source: "job",
      observed_at: NOW, next_action: "contact_support", reconnect_can_help: false, retry_at: null, support_correlation_id: "fixture-correlation" },
    connection: { state: "verified", reason_code: null }, permission: { state: "missing", observed_at: COLLECTED, missing_scopes: [] },
    last_attempt: { state: "failed", reason_code: "permission_missing", observed_at: COLLECTED },
  };
  stored.readiness = readiness;
  const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(report.permission?.state, "missing");
  assertEquals(report.permission?.missing_scopes, []);
  for (const patch of [{ last_attempt: null }, { permission: { ...report.permission!, observed_at: NOW } },
    { last_attempt: { ...readiness.last_attempt, state: "retry" } }]) {
    const invalid = { ...stored, readiness: { ...readiness, ...patch } };
    assertThrows(() => assembleStoredAnalytics({ stored: invalid, windows, generatedAt: NOW, nextCursor: null, hasMore: false }), PersistedReportRefused);
  }
  for (const [reason_code, reason_source] of [["collection_disabled", "rollout_policy"],
    ["collection_not_eligible", "rollout_policy"], ["settings_unavailable", "configuration"]]) {
    const policy = { ...stored, readiness: { ...readiness, collection: { ...readiness.collection,
      reason_code, reason_source, state: reason_code === "settings_unavailable" ? "unavailable" : "not_enabled" } } };
    const saved = assembleStoredAnalytics({ stored: policy, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
    assertEquals(saved.collection?.reason_code, reason_code);
    assertEquals(saved.permission?.state, "missing");
    assertEquals(saved.data?.observation_count, report.data?.observation_count);
  }
});

Deno.test("a partial job without received numerical observations is never partially synced", () => {
  const stored = fixture();
  stored.daily = [];
  stored.collection.latest = { ...stored.collection.latest!, state: "partial" };
  stored.inventory = { complete: false, truncated: false };
  const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(report.sync.status, "never_synced");
});

Deno.test("historical partial jobs cannot make complete requested measurements partially synced", () => {
  const stored = fixture();
  stored.collection.latest = { ...stored.collection.latest!, state: "partial" };
  const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(report.data?.state, "complete");
  assertEquals(report.sync.status, "fresh");
});

function fixture(): StoredAnalyticsSnapshot {
  const definitions = analyticsDefinitions("facebook", "account").filter((entry) => entry.capability === "available" && entry.windowKind === "day");
  const daily = [...windows.previous.buckets, ...windows.current.buckets].map((day, index) => ({
    bucket: { metric_date: day.date, period_start: day.since, period_end: day.until, provider_timezone: "America/Los_Angeles" },
    metrics: definitions.map((definition) => ({ metric_key: definition.key, status: "available" as const,
      value: definition.key === "followers" ? index + 20 : 0, reason: null, provider_metric: definition.providerMetric,
      api_version: definition.apiVersion, window_kind: definition.windowKind, provider_timezone: "America/Los_Angeles",
      window_since: day.since, window_until: day.until, source_ref: "meta_graph_v25", observed_at: COLLECTED, collected_at: COLLECTED })),
  }));
  return { ok: true, platform: "facebook", account_id: ACCOUNT, revision: 4, retention_floor: "2025-11-01T00:00:00Z", as_of: windows.current.period.until,
    since: windows.current.period.since, until: windows.current.period.until, previous_since: windows.previous.period.since, timezone: "America/Los_Angeles",
    health: { active: true, needs_reauth: false, token_expired: false }, inventory: { complete: true, truncated: false }, daily, posts: [], profile_boundaries: [], profile_current: [], period_totals: [],
    collection: { syncing: false, last_success_at: COLLECTED, last_partial_at: null, latest: { state: "success", reason_code: null,
      retry_at: null, due_at: windows.current.period.until, next_due_at: "2026-11-02T08:00:00Z", completed_at: COLLECTED } } };
}

Deno.test("saved report keeps true zero, last follower sample and unsummable unique counts distinct", () => {
  const report = assembleStoredAnalytics({ stored: fixture(), windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  const views = report.metrics.find((metric) => metric.definition.key === "views")!;
  const followers = report.metrics.find((metric) => metric.definition.key === "followers")!;
  const unique = report.metrics.find((metric) => metric.definition.key === "unique_viewers")!;
  assertEquals(views.current, { status: "available", value: 0 });
  assertEquals(views.delta, { status: "unavailable", absolute: 0, percentage: null, reason: "zero_baseline" });
  assertEquals(followers.current, { status: "available", value: 33 });
  assertEquals(followers.previous, { status: "available", value: 26 });
  assertEquals(unique.current, { status: "unavailable", reason: "window_mismatch" });
  assertEquals(unique.trend.every((point) => point.metric.status === "available" && point.metric.value === 0), true);
  assertEquals(report.sync.status, "fresh");
});

Deno.test("the lookahead post that only signals another page cannot change report freshness or paging", () => {
  const base = fixture();
  const newer = { ...base.daily[0].metrics[0], collected_at: "2026-11-01T11:30:00.000Z", observed_at: "2026-11-01T11:30:00.000Z" };
  const post = (index: number, metrics: typeof base.daily[0]["metrics"]) => ({ metrics,
    post: { platform_post_id: `post-${index}`, published_at: "2026-10-30T08:00:00.000Z", post_text: "", permalink: null, captured_on: "2026-11-01" } });
  const posts = Array.from({ length: 25 }, (_, index) => post(index, []));
  const without = assembleStoredAnalytics({ stored: { ...base, posts }, windows, generatedAt: NOW, nextCursor: "next", hasMore: true });
  const withLookahead = assembleStoredAnalytics({ stored: { ...base, posts: [...posts, post(25, [newer])] }, windows, generatedAt: NOW, nextCursor: "next", hasMore: true });
  assertEquals(withLookahead.sync.collectedAt, COLLECTED);
  assertEquals(withLookahead.sync.asOf, without.sync.asOf);
  assertEquals(withLookahead.posts.items.length, 25);
  assertEquals([withLookahead.posts.nextCursor, withLookahead.posts.truncated], ["next", true]);
});

Deno.test("saved report preserves unavailable causes and partial coverage without inventing missing days", () => {
  const stored = fixture();
  const first = stored.daily[7].metrics.find((cell) => cell.metric_key === "views")!;
  first.status = "unavailable"; first.value = null; first.reason = "permission_missing";
  stored.daily[8].metrics = stored.daily[8].metrics.filter((cell) => cell.metric_key !== "views");
  stored.daily[9].metrics.find((cell) => cell.metric_key === "engagements")!.status = "unavailable";
  const engagement = stored.daily[9].metrics.find((cell) => cell.metric_key === "engagements")!;
  engagement.value = null; engagement.reason = "provider_error";
  const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  const views = report.metrics.find((metric) => metric.definition.key === "views")!;
  assertEquals(views.current, { status: "partial", value: 0, coverage: { availableDays: 5, expectedDays: 7 } });
  assertEquals(views.trend[0].metric, { status: "unavailable", reason: "permission_missing" });
  assertEquals(views.trend[1].metric, { status: "unavailable", reason: "not_collected" });
  assertEquals(report.metrics.find((metric) => metric.definition.key === "engagements")!.trend[2].metric, { status: "unavailable", reason: "provider_error" });
  assertEquals(report.sync.status, "partial");
});

Deno.test("terminal inventory bounds remain partial while actual connection failures stay failed", async (test) => {
  for (const reason of ["inventory_truncated", "provider_error", "permission_missing", "reauth_required"]) {
    await test.step(reason, () => {
      const stored = fixture();
      stored.inventory = { complete: false, truncated: true };
      stored.collection.latest = { ...stored.collection.latest!, state: "failed", reason_code: reason };
      const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
      assertEquals(report.sync.status, reason === "inventory_truncated" ? "partial" : "failed");
      assertEquals(report.sync.reason, reason === "inventory_truncated" ? null : reason);
      assertEquals(report.posts.status, "partial");
      assertEquals(report.truncated, true);
      assertEquals(report.metrics.find((metric) => metric.definition.key === "views")!.current, { status: "available", value: 0 });
    });
  }
});

Deno.test("previous Threads follower observations preserve the 24-hour age contract across DST", async (test) => {
  for (const now of ["2026-03-16T12:00:00.000Z", "2026-11-09T12:00:00.000Z"]) {
    const calendar = closedAnalyticsPeriods({ now, days: 7, timezone: "America/Los_Angeles" });
    const lastDay = calendar.previous.buckets.at(-1)!;
    const definition = analyticsDefinitions("threads", "account").find((metric) => metric.key === "followers")!;
    for (const scenario of ["age_limit", "too_old", "after_boundary"] as const) {
      await test.step(`${lastDay.date}: ${scenario}`, () => {
        const boundary = Date.parse(calendar.previous.period.until);
        const observedAt = new Date(scenario === "after_boundary" ? boundary + 1 : boundary - 86_400_000 - (scenario === "too_old" ? 1 : 0)).toISOString();
        const stored = fixture();
        Object.assign(stored, { platform: "threads", daily: [], since: calendar.current.period.since, until: calendar.current.period.until,
          previous_since: calendar.previous.period.since, as_of: calendar.current.period.until });
        stored.profile_boundaries = [{ boundary: calendar.previous.period.until, metric_key: "followers", status: "available", value: 10, reason: null,
          provider_metric: definition.providerMetric, api_version: definition.apiVersion, window_kind: "point_in_time", provider_timezone: null,
          window_since: null, window_until: null, source_ref: "threads_graph_v1", observed_at: observedAt, collected_at: now }];
        const report = assembleStoredAnalytics({ stored, windows: calendar, generatedAt: now, nextCursor: null, hasMore: false });
        const followers = report.metrics.find((metric) => metric.definition.key === "followers")!;
        assertEquals(followers.previous, scenario === "age_limit" ? { status: "available", value: 10 }
          : { status: "unavailable", reason: scenario === "too_old" ? "not_collected" : "window_mismatch" });
        assertEquals(followers.previousObservedAt, observedAt);
      });
    }
  }
});

Deno.test("history cursor preserves SQL precision and its frozen calendar across midnight", async (test) => {
  const cursor = await storedReportCursor({ scope, period: windows.current.period, revision: 4, publishedAt: "2026-10-31T12:00:00.123456Z", postId: "772001_9001", secret: "fixture-sign" });
  const position = await storedReportPosition({ cursor, scope, now: "2026-11-03T12:00:00Z", secret: "fixture-sign" });
  assertEquals(position.after?.publishedAt, "2026-10-31T12:00:00.123456Z");
  assertEquals(position.after?.revision, 4);
  assertEquals(position.windows.current.period, windows.current.period);
  for (const other of [{ ...scope, ownerId: ACCOUNT }, { ...scope, accountId: OWNER }, { ...scope, platform: "threads" as const }, { ...scope, days: 14 as const }]) {
    await test.step(JSON.stringify(other), async () => {
      await assertRejects(() => storedReportPosition({ cursor, scope: other, now: NOW, secret: "fixture-sign" }), PersistedReportRefused);
    });
  }
  await assertRejects(() => storedReportPosition({ cursor: `${cursor.slice(0, -3)}bad`, scope, now: NOW, secret: "fixture-sign" }), PersistedReportRefused);
});

Deno.test("report refuses failed/malformed storage instead of returning an empty successful response", async (test) => {
  for (const { envelope, status } of [{ envelope: { data: null, error: { code: "57014", message: "fixture-secret" } }, status: 503 },
    { envelope: { data: [], error: null }, status: 503 }, { envelope: { data: { ok: false, reason: "history_revision_changed" }, error: null }, status: 409 }]) {
    await test.step(JSON.stringify(envelope), async () => {
      let audits = 0;
      const handler = createStoredReportHandler({ authenticate: async () => ({ userId: OWNER }), secret: "fixture-sign",
        rpc: () => Promise.resolve(envelope), audit: async () => { audits++; return true; } });
      const response = await handler(new Request("https://saved-analytics.invalid", { method: "POST", body: JSON.stringify({ platform: "facebook", accountId: ACCOUNT, analyticsContractVersion: 1 }) }));
      assertEquals(response.status, status);
      assertEquals((await response.text()).includes("fixture-secret"), false);
      assertEquals(audits, 1);
    });
  }
});

Deno.test("ordinary caller identity wins over body owner and real empty history stays never synced", async () => {
  const handler = createStoredReportHandler({ secret: "fixture-sign", audit: async () => true,
    authenticate: async (_request, bodyOwner) => { assertEquals(bodyOwner, ACCOUNT); return { userId: OWNER }; },
    rpc: (_name, args) => {
      assertEquals(args.p_user_id, OWNER);
      const request = args.p_request as { since: string; until: string };
      const queried = closedAnalyticsPeriods({ now: request.until, days: 7, timezone: "America/Los_Angeles" });
      const stored = fixture();
      Object.assign(stored, { daily: [], posts: [], revision: null, since: request.since, until: request.until,
        as_of: request.until, previous_since: queried.previous.period.since, inventory: { complete: false, truncated: false },
        collection: { latest: null, syncing: false, last_success_at: null, last_partial_at: null } });
      return Promise.resolve({ data: stored, error: null });
    } });
  const response = await handler(new Request("https://saved-analytics.invalid", { method: "POST", body: JSON.stringify({ platform: "facebook", accountId: ACCOUNT, user_id: ACCOUNT, analyticsContractVersion: 1 }) }));
  const report = await response.json();
  assertEquals(response.status, 200, JSON.stringify(report));
  assertEquals(report.sync.status, "never_synced");
  assertEquals(report.metrics.find((metric: { definition: { key: string } }) => metric.definition.key === "views").current,
    { status: "unavailable", reason: "not_collected" });
});

Deno.test("bounded body abort never waits for an ignored read or cancellation", async () => {
  const controller = new AbortController();
  let cancelled = false;
  const body = new ReadableStream<Uint8Array>({ cancel: () => { cancelled = true; return new Promise(() => undefined); } });
  const request = new Request("https://saved-analytics.invalid", { method: "POST", body });
  const pending = readJsonBodyCapped(request, 8192, controller.signal);
  controller.abort();
  await assertRejects(() => pending, DOMException);
  assertEquals(cancelled, true);
});

Deno.test("inventory DTO accepts legacy flags and coherent checkpoint provenance", async (test) => {
  const source = { job_id: ACCOUNT, due_on: "2026-11-01", job_generation: 1, checkpoint_updated_at: COLLECTED };
  for (const inventory of [{ complete: true, truncated: false },
    { complete: true, truncated: false, state: "complete", source },
    { complete: false, truncated: false, state: "incomplete", source },
    { complete: false, truncated: true, state: "truncated", source },
    { complete: false, truncated: false, state: "unknown", source: null }]) {
    await test.step(JSON.stringify(inventory), async () => {
      const stored = await readStoredAnalytics({ rpc: () => Promise.resolve({ data: { ...fixture(), inventory }, error: null }),
        platform: "facebook", ownerId: OWNER, accountId: ACCOUNT, request: {}, signal: new AbortController().signal });
      assertEquals(stored.inventory, inventory);
      const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
      assertEquals(report.posts.status, inventory.complete ? "available" : "partial");
      stored.collection.syncing = true;
      assertEquals(assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false }).sync.status, "syncing");
    });
  }
});

Deno.test("inventory DTO refuses contradictory flags, states and provenance", async (test) => {
  const source = { job_id: ACCOUNT, due_on: "2026-11-01", job_generation: 1, checkpoint_updated_at: COLLECTED };
  for (const inventory of [{ complete: true, truncated: true },
    { complete: "true", truncated: false },
    { complete: true, truncated: false, state: "unknown", source: null },
    { complete: false, truncated: false, state: "unknown", source },
    { complete: true, truncated: false, state: "complete", source: null },
    { complete: false, truncated: false, state: "truncated", source },
    { complete: false, truncated: false, state: "complete", source },
    { complete: false, truncated: false, state: "other", source },
    { complete: false, truncated: false, state: "incomplete" },
    { complete: false, truncated: false, state: "incomplete", source: { ...source, job_generation: 0 } }]) {
    await test.step(JSON.stringify(inventory), async () => {
      await assertRejects(() => readStoredAnalytics({ rpc: () => Promise.resolve({ data: { ...fixture(), inventory }, error: null }),
        platform: "facebook", ownerId: OWNER, accountId: ACCOUNT, request: {}, signal: new AbortController().signal }),
      PersistedReportRefused, "invalid_contract");
    });
  }
});

Deno.test("incompatible available cells cannot manufacture numerical report evidence", () => {
  for (const change of [{ api_version: "v0.0" }, { source_ref: "unverified" }, { window_kind: "lifetime" as const },
    { window_since: "2020-01-01T00:00:00Z" }]) {
    const stored = fixture();
    stored.daily = stored.daily.map((day) => ({ ...day, metrics: day.metrics.map((cell) => ({ ...cell, ...change })) }));
    const report = assembleStoredAnalytics({ stored, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
    assertEquals(report.data?.observation_count, 0);
    assertEquals(report.data?.state, "empty");
    assertEquals(report.sync.collectedAt, null);
  }
});

Deno.test("data evidence covers all period posts and account readiness survives an empty period", () => {
  const stored = fixture();
  stored.daily = [];
  const definition = analyticsDefinitions("facebook", "post").find((entry) => entry.key === "views")!;
  const post = { post: { platform_post_id: "saved-post", published_at: windows.current.buckets[0].since, post_text: "", permalink: null, captured_on: "2026-11-01" },
    metrics: [{ metric_key: definition.key, status: "available" as const, value: 0, reason: null, provider_metric: definition.providerMetric,
      api_version: definition.apiVersion, window_kind: definition.windowKind, provider_timezone: null,
      window_since: null, window_until: null, source_ref: "meta_graph_v25", observed_at: COLLECTED, collected_at: COLLECTED }] };
  const first = assembleStoredAnalytics({ stored: { ...stored, posts: [post], period_posts: [post], account_has_measurements: true }, windows, generatedAt: NOW, nextCursor: "next", hasMore: true });
  const next = assembleStoredAnalytics({ stored: { ...stored, posts: [], period_posts: [post], account_has_measurements: true }, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(next.data, first.data);
  assertEquals(next.data?.observation_count, 1);
  const empty = assembleStoredAnalytics({ stored: { ...stored, period_posts: [], account_has_measurements: true, readiness: {
    collection: { contract_version: 2, state: "syncing", reason_code: "awaiting_first_capture", reason_source: "data", observed_at: NOW,
      next_action: "wait", reconnect_can_help: false, retry_at: null, support_correlation_id: "fixture" },
    connection: { state: "verified", reason_code: null }, permission: { state: "verified", observed_at: NOW, missing_scopes: [] }, last_attempt: null,
  } }, windows, generatedAt: NOW, nextCursor: null, hasMore: false });
  assertEquals(empty.collection?.reason_code, "ready");
  assertEquals(empty.data?.state, "empty");
});
