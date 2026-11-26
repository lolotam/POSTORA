import { vi } from "vitest";
import type { YouTubeAnalyticsGateway } from "../application/ports";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import type {
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsErrorCode,
  YouTubeAnalyticsPeriodDays,
  YouTubeAnalyticsStatusData,
  YouTubeAnalyticsSuccess,
  YouTubeAnalyticsSummaryData,
  YouTubeAnalyticsTopVideosData,
} from "../domain/types";

export const USER_ID = "11111111-1111-4111-8111-111111111111";
export const ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";
export const OTHER_ACCOUNT_ID = "44444444-4444-4444-8444-444444444444";
export const REVISION = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
export const NEW_REVISION = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
export const WINDOW_END = "2026-11-17";
export const PERIOD: YouTubeAnalyticsPeriodDays = 7;
export const VIDEO_ID = "videoAAAAAAA";

export function requestedWindow(days = PERIOD) {
  const start = new Date(`${WINDOW_END}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { start_date: start.toISOString().slice(0, 10), end_date: WINDOW_END, days, time_zone: "America/Los_Angeles" as const };
}

export function success<T>(data: T, revision = REVISION, withWindow = true): YouTubeAnalyticsSuccess<T> {
  return {
    schema_version: 1,
    request_id: "req-fixture",
    connection_revision: revision,
    freshness: { fetched_at: "2026-11-20T12:00:00Z", source: "provider" },
    ...(withWindow ? { requested_window: requestedWindow(30) } : {}),
    data,
  };
}

export function statusData(revision = REVISION): YouTubeAnalyticsStatusData {
  return {
    available: true,
    reason: "ok",
    connection_revision: revision,
    reporting_end_date: WINDOW_END,
    accepted_window_ends: [WINDOW_END, "2026-11-16"],
    consent: { state: "accepted", version: 1 },
    purpose_version: 1,
    periods: [7, 14, 30, 90],
    limits: {
      admission: { max: 120, windowSeconds: 60 },
      dataBurst: { max: 60, windowSeconds: 600 },
      dataDaily: { max: 300, windowSeconds: 86400 },
      sharedData: { max: 1000, windowSeconds: 172800 },
      sharedAnalytics: { max: 2000, windowSeconds: 172800 },
    },
  };
}

const summaryMetrics = [
  ["views", "count", 120],
  ["watch_time", "minutes", 65],
  ["average_view_duration", "seconds", 32],
  ["subscribers_gained", "count", 8],
  ["subscribers_lost", "count", 2],
  ["likes", "count", 14],
  ["comments", "count", 3],
  ["shares", "count", 1],
] as const;

export function summaryData(): YouTubeAnalyticsSummaryData {
  return { metrics: summaryMetrics.map(([key, unit, value]) => ({ key, unit, value })), has_data: true };
}

export function dailyData(): YouTubeAnalyticsDailyData {
  return {
    rows: [{ day: WINDOW_END, metrics: [
      { key: "views", unit: "count", value: 12 },
      { key: "watch_time", unit: "minutes", value: 6 },
      { key: "subscribers_gained", unit: "count", value: 1 },
      { key: "subscribers_lost", unit: "count", value: 0 },
    ] }],
    coverage: { first_day: WINDOW_END, last_day: WINDOW_END, days_returned: 1, days_missing: 6 },
  };
}

export function topVideosData(title = "Fixture video"): YouTubeAnalyticsTopVideosData {
  return {
    titles: "complete",
    has_more: false,
    next_start_index: null,
    rows: [{
      video_id: VIDEO_ID,
      title,
      published_at: "2026-11-01T12:00:00Z",
      thumbnail_url: "https://i.ytimg.com/vi/videoAAAAAAA/mqdefault.jpg",
      link: `https://www.youtube.com/watch?v=${VIDEO_ID}`,
      metrics: [
        { key: "watch_time", unit: "minutes", value: 20 },
        { key: "views", unit: "count", value: 40 },
        { key: "likes", unit: "count", value: 4 },
        { key: "subscribers_gained", unit: "count", value: 2 },
      ],
    }],
  };
}

export function makeGateway(overrides: Partial<YouTubeAnalyticsGateway> = {}): YouTubeAnalyticsGateway {
  return {
    status: vi.fn(async () => success(statusData(), REVISION, false)),
    acceptConsent: vi.fn(async () => success({ recorded: true, consent: { state: "accepted" as const, version: 1 }, purpose_version: 1 }, REVISION, false)),
    withdrawConsent: vi.fn(async () => success({ recorded: true, consent: { state: "withdrawn" as const, version: 1 }, purpose_version: 1 }, REVISION, false)),
    summary: vi.fn(async () => success(summaryData())),
    daily: vi.fn(async () => success(dailyData())),
    topVideos: vi.fn(async () => success(topVideosData())),
    ...overrides,
  };
}

export function refusal(code: YouTubeAnalyticsErrorCode, extras: Partial<YouTubeAnalyticsClientError> = {}) {
  return new YouTubeAnalyticsClientError(code, {
    requestId: "req-refusal",
    connectionRevision: REVISION,
    ...extras,
  });
}
