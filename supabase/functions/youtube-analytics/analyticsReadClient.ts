import { classifyGoogleError } from "../_shared/youtubeApiErrors.ts";
import {
  YOUTUBE_ANALYTICS_DAILY_METRICS,
  YOUTUBE_ANALYTICS_SUMMARY_METRICS,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS,
  YOUTUBE_ANALYTICS_VIDEO_ID_PATTERN,
  type YouTubeAnalyticsDailyData,
  type YouTubeAnalyticsErrorCode,
  type YouTubeAnalyticsMetric,
  type YouTubeAnalyticsRequestedWindow,
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
  lookupVideoOwnership(
    accessToken: string,
    input: { channelId: string; videoId: string },
  ): Promise<YouTubeAnalyticsReadResult<{ owned: true }>>;
  lookupVideoTitles(
    accessToken: string,
    input: { channelId: string; videoIds: string[] },
  ): Promise<YouTubeAnalyticsReadResult<{ titles: Record<string, string> }>>;
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
      for (const item of result.items) {
        const raw = record(item);
        const snippet = record(raw?.snippet);
        if (typeof raw?.id === "string" && input.videoIds.includes(raw.id) &&
          snippet?.channelId === input.channelId && typeof snippet.title === "string") {
          titles[raw.id] = snippet.title;
        }
      }
      return { ok: true, value: { titles } };
    },
  };
}
