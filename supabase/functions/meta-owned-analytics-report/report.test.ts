import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { closedAnalyticsPeriods } from "../_shared/analyticsCalendar.ts";
import { analyticsDefinitions } from "../_shared/analyticsRegistry.ts";
import { assembleStoredAnalytics } from "./assemble.ts";
import { storedReportCursor, storedReportPosition, type StoredReportScope } from "./cursor.ts";
import { createStoredReportHandler } from "./handler.ts";
import { PersistedReportRefused, type StoredAnalyticsSnapshot } from "./store.ts";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";

const OWNER = "d1000000-0000-4000-8000-000000000001";
const ACCOUNT = "d2000000-0000-4000-8000-000000000001";
const NOW = "2026-11-01T12:00:00.000Z";
const COLLECTED = "2026-11-01T10:00:00.000Z";
const scope: StoredReportScope = { platform: "facebook", ownerId: OWNER, accountId: ACCOUNT, days: 7 };
const windows = closedAnalyticsPeriods({ now: NOW, days: 7, timezone: "America/Los_Angeles" });

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

Deno.test("previous Threads follower observations follow the final provider day across DST", async (test) => {
  for (const now of ["2026-03-16T12:00:00.000Z", "2026-11-09T12:00:00.000Z"]) {
    const calendar = closedAnalyticsPeriods({ now, days: 7, timezone: "America/Los_Angeles" });
    const lastDay = calendar.previous.buckets.at(-1)!;
    const definition = analyticsDefinitions("threads", "account").find((metric) => metric.key === "followers")!;
    for (const scenario of ["start", "too_old", "after_boundary"] as const) {
      await test.step(`${lastDay.date}: ${scenario}`, () => {
        const observedAt = scenario === "start" ? lastDay.since : new Date(Date.parse(scenario === "too_old" ? lastDay.since : lastDay.until) + (scenario === "too_old" ? -1 : 1)).toISOString();
        const stored = fixture();
        Object.assign(stored, { platform: "threads", daily: [], since: calendar.current.period.since, until: calendar.current.period.until,
          previous_since: calendar.previous.period.since, as_of: calendar.current.period.until });
        stored.profile_boundaries = [{ boundary: calendar.previous.period.until, metric_key: "followers", status: "available", value: 10, reason: null,
          provider_metric: definition.providerMetric, api_version: definition.apiVersion, window_kind: "point_in_time", provider_timezone: null,
          window_since: null, window_until: null, source_ref: "threads_graph_v1", observed_at: observedAt, collected_at: now }];
        const report = assembleStoredAnalytics({ stored, windows: calendar, generatedAt: now, nextCursor: null, hasMore: false });
        const followers = report.metrics.find((metric) => metric.definition.key === "followers")!;
        assertEquals(followers.previous, scenario === "start" ? { status: "available", value: 10 }
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
