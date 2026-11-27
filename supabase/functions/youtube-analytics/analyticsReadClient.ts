import { classifyGoogleError } from "../_shared/youtubeApiErrors.ts";
import {
  YOUTUBE_ANALYTICS_BREAKDOWN_METRICS,
  YOUTUBE_ANALYTICS_COUNTRY_PATTERN,
  YOUTUBE_ANALYTICS_DAILY_METRICS,
  YOUTUBE_ANALYTICS_DEVICE_PATTERN,
  YOUTUBE_ANALYTICS_DEVICES_MAX_ROWS,
  YOUTUBE_ANALYTICS_GEOGRAPHY_MAX_ROWS,
  YOUTUBE_ANALYTICS_RETENTION_MAX_POINTS,
  YOUTUBE_ANALYTICS_SUMMARY_METRICS,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS,
  YOUTUBE_ANALYTICS_TRAFFIC_SOURCE_PATTERN,
  YOUTUBE_ANALYTICS_TRAFFIC_SOURCES_MAX_ROWS,
  YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN,
  type YouTubeAnalyticsBreakdownData,
  type YouTubeAnalyticsBreakdownDimension,
  type YouTubeAnalyticsBreakdownOperation,
  type YouTubeAnalyticsBreakdownRow,
  type YouTubeAnalyticsDailyData,
  type YouTubeAnalyticsErrorCode,
  type YouTubeAnalyticsMetric,
  type YouTubeAnalyticsRequestedWindow,
  type YouTubeAnalyticsRetentionData,
  type YouTubeAnalyticsRetentionPoint,
  type YouTubeAnalyticsSummaryData,
} from "./contracts.ts";

const ANALYTICS_REPORTS_URL = "https://youtubeanalytics.googleapis.com/v2/reports";
const DATA_VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const REQUEST_TIMEOUT_MS = 15_000;

export type YouTubeAnalyticsReadFailure = {
  ok: false;
  code: Extract<
    YouTubeAnalyticsErrorCode,
    | "unauthorized"
    | "quota_exceeded"
    | "missing_scope"
    | "video_not_found"
    | "upstream_unavailable"
  >;
};

export type YouTubeAnalyticsReadResult<T> = { ok: true; value: T } | YouTubeAnalyticsReadFailure;

export interface YouTubeAnalyticsTopVideoMetricRow {
  videoId: string;
  metrics: YouTubeAnalyticsMetric[];
}

export interface YouTubeAnalyticsTopVideoReport {
  rows: YouTubeAnalyticsTopVideoMetricRow[];
}

export interface YouTubeAnalyticsReportInput {
  channelId: string;
  window: YouTubeAnalyticsRequestedWindow;
  days: string[];
  videoId?: string;
  startIndex?: number;
}

export interface YouTubeAnalyticsReadClient {
  readSummary(
    accessToken: string,
    input: YouTubeAnalyticsReportInput,
  ): Promise<YouTubeAnalyticsReadResult<YouTubeAnalyticsSummaryData>>;
  readDaily(
    accessToken: string,
    input: YouTubeAnalyticsReportInput,
  ): Promise<YouTubeAnalyticsReadResult<YouTubeAnalyticsDailyData>>;
  readTopVideos(
    accessToken: string,
    input: YouTubeAnalyticsReportInput,
  ): Promise<YouTubeAnalyticsReadResult<YouTubeAnalyticsTopVideoReport>>;
  readBreakdown(
    accessToken: string,
    kind: YouTubeAnalyticsBreakdownOperation,
    input: YouTubeAnalyticsReportInput,
  ): Promise<YouTubeAnalyticsReadResult<YouTubeAnalyticsBreakdownData>>;
  readRetention(
    accessToken: string,
    input: YouTubeAnalyticsReportInput & { videoId: string },
  ): Promise<YouTubeAnalyticsReadResult<YouTubeAnalyticsRetentionData>>;
  lookupVideoOwnership(
    accessToken: string,
    input: { channelId: string; videoId: string },
  ): Promise<YouTubeAnalyticsReadResult<{ owned: true }>>;
  lookupVideoTitles(
    accessToken: string,
    input: { channelId: string; videoIds: string[] },
  ): Promise<YouTubeAnalyticsReadResult<{
    titles: Record<string, string>;
    details: Record<string, { published_at: string | null; thumbnail_url: string | null }>;
  }>>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function firstReason(body: unknown): string {
  const errors = record(record(body)?.error)?.errors;
  if (!Array.isArray(errors)) return "";
  const reason = record(errors[0])?.reason;
  return typeof reason === "string" ? reason : "";
}

function providerMessage(body: unknown): string {
  const message = record(record(body)?.error)?.message;
  return typeof message === "string" ? message : "";
}

function classifyResponse(
  status: number,
  body: unknown,
  ownershipLookup = false,
): YouTubeAnalyticsReadFailure {
  const reason = firstReason(body);
  if (ownershipLookup && status === 404 && reason === "videoNotFound") {
    return { ok: false, code: "video_not_found" };
  }
  if (providerMessage(body) === "The query is not supported" || reason === "badRequest" ||
    reason === "accessNotConfigured") {
    return { ok: false, code: "upstream_unavailable" };
  }
  if (reason === "forbidden") return { ok: false, code: "missing_scope" };
  switch (classifyGoogleError(status, body)) {
    case "unauthorized":
      return { ok: false, code: "unauthorized" };
    case "quota":
      return { ok: false, code: "quota_exceeded" };
    case "scope_missing":
    case "forbidden":
      return { ok: false, code: "missing_scope" };
    default:
      return { ok: false, code: "upstream_unavailable" };
  }
}

async function fetchGoogle(
  fetchImpl: typeof fetch,
  url: URL,
  accessToken: string,
  ownershipLookup = false,
): Promise<{ ok: true; body: unknown } | YouTubeAnalyticsReadFailure> {
  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    return { ok: false, code: "upstream_unavailable" };
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return response.ok
      ? { ok: false, code: "upstream_unavailable" }
      : classifyResponse(response.status, null, ownershipLookup);
  }
  if (!response.ok) return classifyResponse(response.status, body, ownershipLookup);
  return { ok: true, body };
}

function exactHeaders(body: unknown, expected: readonly string[]): boolean {
  const headers = record(body)?.columnHeaders;
  return Array.isArray(headers) && headers.length === expected.length && headers.every(
    (header, index) => record(header)?.name === expected[index],
  );
}

function metricValue(
  cell: unknown,
  key: YouTubeAnalyticsMetric["key"],
): number | null | undefined {
  if (cell === null) return null;
  if (typeof cell !== "number" || !Number.isFinite(cell)) return undefined;
  // YouTube Analytics `reports.query` defines `likes`, `comments`, and `shares` as net
  // changes over the period ("Note: This metric can have a negative value",
  // https://developers.google.com/youtube/analytics/metrics; confirmed on production
  // 90-day summary `likes = -2` and top_videos `likes = -1`).
  const canBeNetNegative = key === "likes" || key === "comments" || key === "shares";
  return canBeNetNegative || cell >= 0 ? cell : undefined;
}

function metricsFromRow(
  row: unknown,
  definitions: readonly { key: YouTubeAnalyticsMetric["key"]; unit: YouTubeAnalyticsMetric["unit"] }[],
  offset: number,
): YouTubeAnalyticsMetric[] | null {
  if (!Array.isArray(row) || row.length !== definitions.length + offset) return null;
  const metrics: YouTubeAnalyticsMetric[] = [];
  for (let index = 0; index < definitions.length; index += 1) {
    const value = metricValue(row[index + offset], definitions[index].key);
    if (value === undefined) return null;
    metrics.push({ key: definitions[index].key, unit: definitions[index].unit, value });
  }
  return metrics;
}

function emptySummary(): YouTubeAnalyticsSummaryData {
  return {
    metrics: YOUTUBE_ANALYTICS_SUMMARY_METRICS.map(({ key, unit }) => ({ key, unit, value: null })),
    has_data: false,
  };
}

function emptyDaily(days: string[]): YouTubeAnalyticsDailyData {
  return {
    rows: [],
    coverage: { first_day: null, last_day: null, days_returned: 0, days_missing: days.length },
  };
}

function analyticsUrl(input: YouTubeAnalyticsReportInput, metrics: readonly string[]): URL {
  const url = new URL(ANALYTICS_REPORTS_URL);
  url.searchParams.set("ids", `channel==${input.channelId}`);
  url.searchParams.set("startDate", input.window.start_date);
  url.searchParams.set("endDate", input.window.end_date);
  url.searchParams.set("metrics", metrics.join(","));
  if (input.videoId !== undefined) url.searchParams.set("filters", `video==${input.videoId}`);
  return url;
}

function dataVideosUrl(videoIds: string[]): URL {
  const url = new URL(DATA_VIDEOS_URL);
  url.searchParams.set("part", "snippet");
  url.searchParams.set("id", videoIds.join(","));
  return url;
}

function ytimgThumbnail(snippet: Record<string, unknown>): string | null {
  const thumbnails = record(snippet.thumbnails);
  const selected = record(thumbnails?.medium) ?? record(thumbnails?.high) ?? record(thumbnails?.default);
  if (typeof selected?.url !== "string") return null;
  try {
    const url = new URL(selected.url);
    return url.protocol === "https:" && (url.hostname === "ytimg.com" || url.hostname.endsWith(".ytimg.com"))
      ? url.toString()
      : null;
  } catch {
    return null;
  }
}

function publishedAt(snippet: Record<string, unknown>): string | null {
  const value = snippet.publishedAt;
  return typeof value === "string" && !Number.isNaN(Date.parse(value)) ? value : null;
}

function googleMetricNames(
  definitions: readonly { googleMetric: string }[],
): string[] {
  return definitions.map((definition) => definition.googleMetric);
}

async function readItems(
  fetchImpl: typeof fetch,
  accessToken: string,
  videoIds: string[],
  ownershipLookup: boolean,
): Promise<{ ok: true; items: unknown[] } | YouTubeAnalyticsReadFailure> {
  const result = await fetchGoogle(fetchImpl, dataVideosUrl(videoIds), accessToken, ownershipLookup);
  if (!result.ok) return result;
  const items = record(result.body)?.items;
  if (!Array.isArray(items)) return { ok: false, code: "upstream_unavailable" };
  return { ok: true, items };
}

const BREAKDOWN_SPECS: Record<
  YouTubeAnalyticsBreakdownOperation,
  {
    dimension: YouTubeAnalyticsBreakdownDimension;
    googleDimension: string;
    pattern: RegExp;
    maxRows: number;
    maxResults?: string;
  }
> = {
  traffic_sources: {
    dimension: "traffic_source",
    googleDimension: "insightTrafficSourceType",
    pattern: YOUTUBE_ANALYTICS_TRAFFIC_SOURCE_PATTERN,
    maxRows: YOUTUBE_ANALYTICS_TRAFFIC_SOURCES_MAX_ROWS,
  },
  geography: {
    dimension: "country",
    googleDimension: "country",
    pattern: YOUTUBE_ANALYTICS_COUNTRY_PATTERN,
    maxRows: YOUTUBE_ANALYTICS_GEOGRAPHY_MAX_ROWS,
    maxResults: String(YOUTUBE_ANALYTICS_GEOGRAPHY_MAX_ROWS),
  },
  devices: {
    dimension: "device",
    googleDimension: "deviceType",
    pattern: YOUTUBE_ANALYTICS_DEVICE_PATTERN,
    maxRows: YOUTUBE_ANALYTICS_DEVICES_MAX_ROWS,
  },
};

const RETENTION_METRIC_NAMES = ["audienceWatchRatio", "relativeRetentionPerformance"] as const;
const RETENTION_HEADERS = ["elapsedVideoTimeRatio", ...RETENTION_METRIC_NAMES] as const;

function optionalBoundedNumber(value: unknown, min: number, max?: number): number | null | undefined {
  if (value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < min) return undefined;
  if (max !== undefined && value > max) return undefined;
  return value;
}

export function createYouTubeAnalyticsReadClient(options: {
  fetchImpl?: typeof fetch;
} = {}): YouTubeAnalyticsReadClient {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async readSummary(accessToken, input) {
      const names = googleMetricNames(YOUTUBE_ANALYTICS_SUMMARY_METRICS);
      const result = await fetchGoogle(fetchImpl, analyticsUrl(input, names), accessToken);
      if (!result.ok) return result;
      if (!exactHeaders(result.body, names)) return { ok: false, code: "upstream_unavailable" };
      const rows = record(result.body)?.rows;
      if (rows === undefined || rows === null ||
        (Array.isArray(rows) && rows.length === 0)) {
        return { ok: true, value: emptySummary() };
      }
      if (!Array.isArray(rows) || rows.length > 1) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const metrics = metricsFromRow(rows[0], YOUTUBE_ANALYTICS_SUMMARY_METRICS, 0);
      if (metrics === null) return { ok: false, code: "upstream_unavailable" };
      return { ok: true, value: { metrics, has_data: true } };
    },

    async readDaily(accessToken, input) {
      const names = ["day", ...googleMetricNames(YOUTUBE_ANALYTICS_DAILY_METRICS)];
      const url = analyticsUrl(input, names.slice(1));
      url.searchParams.set("dimensions", "day");
      url.searchParams.set("sort", "day");
      const result = await fetchGoogle(fetchImpl, url, accessToken);
      if (!result.ok) return result;
      if (!exactHeaders(result.body, names)) return { ok: false, code: "upstream_unavailable" };
      const rows = record(result.body)?.rows;
      if (rows === undefined || rows === null ||
        (Array.isArray(rows) && rows.length === 0)) {
        return { ok: true, value: emptyDaily(input.days) };
      }
      if (!Array.isArray(rows)) return { ok: false, code: "upstream_unavailable" };
      const allowedDays = new Set(input.days);
      const seen = new Set<string>();
      const validated: YouTubeAnalyticsDailyData["rows"] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== "string" ||
          !allowedDays.has(row[0]) || seen.has(row[0])) {
          return { ok: false, code: "upstream_unavailable" };
        }
        const metrics = metricsFromRow(row, YOUTUBE_ANALYTICS_DAILY_METRICS, 1);
        if (metrics === null) return { ok: false, code: "upstream_unavailable" };
        seen.add(row[0]);
        validated.push({ day: row[0], metrics });
      }
      validated.sort((left, right) => left.day.localeCompare(right.day));
      return {
        ok: true,
        value: {
          rows: validated,
          coverage: {
            first_day: validated[0]?.day ?? null,
            last_day: validated.at(-1)?.day ?? null,
            days_returned: validated.length,
            days_missing: input.days.length - validated.length,
          },
        },
      };
    },

    async readTopVideos(accessToken, input) {
      const metricNames = googleMetricNames(YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS);
      const names = ["video", ...metricNames];
      const url = analyticsUrl(input, metricNames);
      url.searchParams.set("dimensions", "video");
      url.searchParams.set("sort", "-views");
      url.searchParams.set("maxResults", "10");
      url.searchParams.set("startIndex", String(input.startIndex ?? 1));
      const result = await fetchGoogle(fetchImpl, url, accessToken);
      if (!result.ok) return result;
      if (!exactHeaders(result.body, names)) return { ok: false, code: "upstream_unavailable" };
      const rows = record(result.body)?.rows;
      if (rows === undefined || rows === null ||
        (Array.isArray(rows) && rows.length === 0)) {
        return { ok: true, value: { rows: [] } };
      }
      if (!Array.isArray(rows) || rows.length > 10) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const seen = new Set<string>();
      const validated: YouTubeAnalyticsTopVideoMetricRow[] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== "string" ||
          !YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN.test(row[0]) || seen.has(row[0])) {
          return { ok: false, code: "upstream_unavailable" };
        }
        const metrics = metricsFromRow(row, YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS, 1);
        if (metrics === null) return { ok: false, code: "upstream_unavailable" };
        seen.add(row[0]);
        validated.push({ videoId: row[0], metrics });
      }
      return { ok: true, value: { rows: validated } };
    },

    async readBreakdown(accessToken, kind, input) {
      const spec = BREAKDOWN_SPECS[kind];
      const metricNames = googleMetricNames(YOUTUBE_ANALYTICS_BREAKDOWN_METRICS);
      const names = [spec.googleDimension, ...metricNames];
      const url = analyticsUrl(input, metricNames);
      url.searchParams.set("dimensions", spec.googleDimension);
      url.searchParams.set("sort", "-views");
      if (spec.maxResults !== undefined) url.searchParams.set("maxResults", spec.maxResults);
      const result = await fetchGoogle(fetchImpl, url, accessToken);
      if (!result.ok) return result;
      if (!exactHeaders(result.body, names)) return { ok: false, code: "upstream_unavailable" };
      const rows = record(result.body)?.rows;
      if (rows === undefined || rows === null || (Array.isArray(rows) && rows.length === 0)) {
        return { ok: true, value: { dimension: spec.dimension, rows: [], has_data: false } };
      }
      if (!Array.isArray(rows) || rows.length > spec.maxRows) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const seen = new Set<string>();
      const validated: YouTubeAnalyticsBreakdownRow[] = [];
      for (const row of rows) {
        if (!Array.isArray(row) || typeof row[0] !== "string" ||
          !spec.pattern.test(row[0]) || seen.has(row[0])) {
          return { ok: false, code: "upstream_unavailable" };
        }
        const metrics = metricsFromRow(row, YOUTUBE_ANALYTICS_BREAKDOWN_METRICS, 1);
        if (metrics === null) return { ok: false, code: "upstream_unavailable" };
        seen.add(row[0]);
        validated.push({ key: row[0], metrics });
      }
      return { ok: true, value: { dimension: spec.dimension, rows: validated, has_data: true } };
    },

    async readRetention(accessToken, input) {
      const url = analyticsUrl(input, RETENTION_METRIC_NAMES);
      url.searchParams.set("dimensions", "elapsedVideoTimeRatio");
      url.searchParams.set("sort", "elapsedVideoTimeRatio");
      const result = await fetchGoogle(fetchImpl, url, accessToken);
      if (!result.ok) return result;
      if (!exactHeaders(result.body, RETENTION_HEADERS)) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const rows = record(result.body)?.rows;
      if (rows === undefined || rows === null || (Array.isArray(rows) && rows.length === 0)) {
        return { ok: true, value: { points: [], has_data: false } };
      }
      if (!Array.isArray(rows) || rows.length > YOUTUBE_ANALYTICS_RETENTION_MAX_POINTS) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const points: YouTubeAnalyticsRetentionPoint[] = [];
      let previousRatio = 0;
      for (const row of rows) {
        if (!Array.isArray(row) || row.length !== 3) {
          return { ok: false, code: "upstream_unavailable" };
        }
        const ratio = row[0];
        if (typeof ratio !== "number" || !Number.isFinite(ratio) || ratio <= 0 || ratio > 1 ||
          ratio <= previousRatio) {
          return { ok: false, code: "upstream_unavailable" };
        }
        const watchRatio = optionalBoundedNumber(row[1], 0);
        const relativePerformance = optionalBoundedNumber(row[2], 0, 1);
        if (watchRatio === undefined || relativePerformance === undefined) {
          return { ok: false, code: "upstream_unavailable" };
        }
        previousRatio = ratio;
        points.push({
          ratio,
          watch_ratio: watchRatio,
          relative_performance: relativePerformance,
        });
      }
      return { ok: true, value: { points, has_data: true } };
    },

    async lookupVideoOwnership(accessToken, input) {
      const result = await readItems(fetchImpl, accessToken, [input.videoId], true);
      if (!result.ok) return result;
      let owned = false;
      for (const item of result.items) {
        const raw = record(item);
        const channelId = record(raw?.snippet)?.channelId;
        if (!raw || typeof raw.id !== "string" || typeof channelId !== "string" || channelId.length === 0) {
          return { ok: false, code: "upstream_unavailable" };
        }
        if (raw.id === input.videoId && channelId === input.channelId) {
          owned = true;
        }
      }
      return owned
        ? { ok: true, value: { owned: true } }
        : { ok: false, code: "video_not_found" };
    },

    async lookupVideoTitles(accessToken, input) {
      if (input.videoIds.length === 0 || input.videoIds.length > 10 ||
        !input.videoIds.every((id) => YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN.test(id))) {
        return { ok: false, code: "upstream_unavailable" };
      }
      const result = await readItems(fetchImpl, accessToken, input.videoIds, false);
      if (!result.ok) return result;
      const titles: Record<string, string> = {};
      const details: Record<string, { published_at: string | null; thumbnail_url: string | null }> = {};
      for (const item of result.items) {
        const raw = record(item);
        const snippet = record(raw?.snippet);
        if (typeof raw?.id !== "string" || !input.videoIds.includes(raw.id) ||
          snippet?.channelId !== input.channelId) continue;
        if (typeof snippet.title === "string") titles[raw.id] = snippet.title;
        details[raw.id] = {
          published_at: publishedAt(snippet),
          thumbnail_url: ytimgThumbnail(snippet),
        };
      }
      return { ok: true, value: { titles, details } };
    },
  };
}
