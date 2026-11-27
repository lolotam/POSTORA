import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ANALYTICS_PURPOSE_ACCEPTED_VERSIONS,
  ANALYTICS_PURPOSE_VERSION,
  YOUTUBE_ANALYTICS_DAILY_METRICS,
  YOUTUBE_ANALYTICS_ERRORS,
  YOUTUBE_ANALYTICS_LIMITS,
  YOUTUBE_ANALYTICS_OPERATIONS,
  YOUTUBE_ANALYTICS_PERIOD_DAYS,
  YOUTUBE_ANALYTICS_REQUIRED_SCOPES,
  YOUTUBE_ANALYTICS_SCHEMA_VERSION,
  YOUTUBE_ANALYTICS_SUMMARY_METRICS,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS,
} from "./contracts.ts";
import {
  acceptedWindowEndDates,
  isIsoCalendarDate,
  pacificBudgetBucketKey,
  pacificDateString,
  reportingEndDate,
  resolveRequestedWindow,
  shiftIsoDate,
} from "./window.ts";

Deno.test("contracts pin the schema, purpose, operations, periods, scopes and metric order", () => {
  assertEquals(YOUTUBE_ANALYTICS_SCHEMA_VERSION, 1);
  assertEquals(ANALYTICS_PURPOSE_VERSION, 2);
  assertEquals(ANALYTICS_PURPOSE_ACCEPTED_VERSIONS, [1, 2]);
  assertEquals(YOUTUBE_ANALYTICS_OPERATIONS, [
    "status",
    "consent_accept",
    "consent_withdraw",
    "summary",
    "daily",
    "top_videos",
    "traffic_sources",
    "geography",
    "devices",
    "retention",
  ]);
  assertEquals(YOUTUBE_ANALYTICS_PERIOD_DAYS, [7, 14, 30, 90]);
  assertEquals(YOUTUBE_ANALYTICS_REQUIRED_SCOPES, [
    "https://www.googleapis.com/auth/youtube.readonly",
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ]);
  assertEquals(YOUTUBE_ANALYTICS_SUMMARY_METRICS.map((metric) => metric.googleMetric), [
    "views",
    "estimatedMinutesWatched",
    "averageViewDuration",
    "subscribersGained",
    "subscribersLost",
    "likes",
    "comments",
    "shares",
  ]);
  assertEquals(YOUTUBE_ANALYTICS_DAILY_METRICS.map((metric) => metric.googleMetric), [
    "views",
    "estimatedMinutesWatched",
    "subscribersGained",
    "subscribersLost",
  ]);
  assertEquals(YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS.map((metric) => metric.googleMetric), [
    "estimatedMinutesWatched",
    "views",
    "likes",
    "subscribersGained",
  ]);
  assertEquals(YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS.map((metric) => metric.key), [
    "watch_time",
    "views",
    "likes",
    "subscribers_gained",
  ]);
});

Deno.test("every error code has its exact HTTP status and page scope", () => {
  assertEquals(YOUTUBE_ANALYTICS_ERRORS, {
    invalid_request: { status: 400, scope: "block" },
    window_stale: { status: 409, scope: "block" },
    unauthorized: { status: 401, scope: "session" },
    not_enabled: { status: 403, scope: "account" },
    consent_required: { status: 403, scope: "account" },
    consent_version_stale: { status: 409, scope: "block" },
    missing_scope: { status: 403, scope: "account" },
    not_found: { status: 404, scope: "account" },
    video_not_found: { status: 404, scope: "video" },
    method_not_allowed: { status: 405, scope: "request" },
    provider_unsupported: { status: 409, scope: "account" },
    reconnect_required: { status: 409, scope: "account" },
    connection_changed: { status: 409, scope: "account" },
    rate_limited: { status: 429, scope: "block" },
    capacity_reached: { status: 429, scope: "block" },
    quota_exceeded: { status: 429, scope: "block" },
    settings_unavailable: { status: 503, scope: "block" },
    upstream_unavailable: { status: 502, scope: "block" },
    internal_error: { status: 500, scope: "block" },
  });
  assertEquals(YOUTUBE_ANALYTICS_LIMITS, {
    admission: { max: 120, windowSeconds: 60 },
    dataBurst: { max: 60, windowSeconds: 600 },
    dataDaily: { max: 300, windowSeconds: 86400 },
    sharedData: { max: 1000, windowSeconds: 172800 },
    sharedAnalytics: { max: 2000, windowSeconds: 172800 },
  });
});

Deno.test("Pacific dates and reporting windows cross the year boundary at 23:59 and 00:01", () => {
  assertEquals(pacificDateString(new Date("2026-12-31T07:59:00.000Z")), "2026-12-30");
  assertEquals(pacificDateString(new Date("2027-01-01T07:59:00.000Z")), "2026-12-31");
  assertEquals(pacificDateString(new Date("2027-01-01T08:01:00.000Z")), "2027-01-01");
  assertEquals(reportingEndDate(new Date("2027-01-01T08:01:00.000Z")), "2026-12-29");
  assertEquals(acceptedWindowEndDates(new Date("2027-01-01T08:01:00.000Z")), ["2026-12-29", "2026-12-28"]);
  assertEquals(shiftIsoDate("2027-01-01", -1), "2026-12-31");
  assertEquals(shiftIsoDate("2028-02-28", 1), "2028-02-29");
});

Deno.test("Pacific budget keys remain calendar-correct across spring-forward and fall-back", () => {
  assertEquals(pacificDateString(new Date("2026-03-08T09:59:00.000Z")), "2026-03-08");
  assertEquals(pacificDateString(new Date("2026-03-08T10:01:00.000Z")), "2026-03-08");
  assertEquals(pacificDateString(new Date("2026-11-01T08:59:00.000Z")), "2026-11-01");
  assertEquals(pacificDateString(new Date("2026-11-01T09:01:00.000Z")), "2026-11-01");
  assertEquals(pacificBudgetBucketKey("data", new Date("2026-03-09T06:59:00.000Z")), "youtube-analytics:budget:data:2026-03-08");
  assertEquals(pacificBudgetBucketKey("data", new Date("2026-03-09T07:01:00.000Z")), "youtube-analytics:budget:data:2026-03-09");
  assertEquals(pacificBudgetBucketKey("analytics", new Date("2026-11-02T07:59:00.000Z")), "youtube-analytics:budget:analytics:2026-11-01");
  assertEquals(pacificBudgetBucketKey("analytics", new Date("2026-11-02T08:01:00.000Z")), "youtube-analytics:budget:analytics:2026-11-02");
});

Deno.test("window resolution returns every requested day and rejects stale or malformed dates", () => {
  const now = new Date("2026-11-20T12:00:00.000Z");
  for (const periodDays of [7, 14, 30, 90] as const) {
    const result = resolveRequestedWindow({ windowEnd: "2026-11-17", periodDays, now });
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.days.length, periodDays);
      assertEquals(result.days.at(-1), "2026-11-17");
      assertEquals(result.days[0], result.window.start_date);
      assertEquals(result.window.end_date, "2026-11-17");
      assertEquals(result.window.time_zone, "America/Los_Angeles");
    }
  }
  assertEquals(resolveRequestedWindow({ windowEnd: "2026-11-16", periodDays: 7, now }), {
    ok: true,
    window: {
      start_date: "2026-11-10",
      end_date: "2026-11-16",
      days: 7,
      time_zone: "America/Los_Angeles",
    },
    days: ["2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16"],
  });
  assertEquals(resolveRequestedWindow({ windowEnd: "2026-11-18", periodDays: 7, now }), { ok: false, code: "window_stale" });
  assertEquals(resolveRequestedWindow({ windowEnd: "2026-11-15", periodDays: 7, now }), { ok: false, code: "window_stale" });
  for (const malformed of ["2026-02-30", "2026-13-01", "2026-1-01", "not-a-date"]) {
    assertEquals(isIsoCalendarDate(malformed), false);
    assertEquals(resolveRequestedWindow({ windowEnd: malformed, periodDays: 7, now }), { ok: false, code: "invalid_request" });
  }
});
