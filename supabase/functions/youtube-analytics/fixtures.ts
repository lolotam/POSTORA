import {
  YOUTUBE_ANALYTICS_DAILY_METRICS,
  YOUTUBE_ANALYTICS_SUMMARY_METRICS,
  YOUTUBE_ANALYTICS_TIME_ZONE,
  YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS,
  type YouTubeAnalyticsRequestedWindow,
} from "./contracts.ts";

export const FIXTURE_NOW = new Date("2026-11-20T12:00:00.000Z");
export const FIXTURE_WINDOW: YouTubeAnalyticsRequestedWindow = {
  start_date: "2026-11-11",
  end_date: "2026-11-17",
  days: 7,
  time_zone: YOUTUBE_ANALYTICS_TIME_ZONE,
};
export const FIXTURE_DAYS = [
  "2026-11-11",
  "2026-11-12",
  "2026-11-13",
  "2026-11-14",
  "2026-11-15",
  "2026-11-16",
  "2026-11-17",
];
export const FIXTURE_VIDEO_ID = "videoAAAAAAA";
export const FIXTURE_OTHER_VIDEO_ID = "videoBBBBBBB";

const headers = (names: readonly string[]) => names.map((name) => ({ name, columnType: "METRIC" }));
const summaryNames = YOUTUBE_ANALYTICS_SUMMARY_METRICS.map((metric) => metric.googleMetric);
const dailyNames = ["day", ...YOUTUBE_ANALYTICS_DAILY_METRICS.map((metric) => metric.googleMetric)];
const topNames = ["video", ...YOUTUBE_ANALYTICS_TOP_VIDEOS_METRICS.map((metric) => metric.googleMetric)];

export const TOTALS = {
  columnHeaders: headers(summaryNames),
  rows: [[11, 22, 3, 4, 1, 5, 2, 6]],
};

export const DAILY = {
  columnHeaders: headers(dailyNames),
  rows: FIXTURE_DAYS.map((day, index) => [day, index + 1, index + 2, index + 3, index]),
};

export const DAILY_MISSING_LAST_TWO = {
  columnHeaders: headers(dailyNames),
  rows: DAILY.rows.slice(0, 5),
};

export const DAILY_MISSING_MIDDLE = {
  columnHeaders: headers(dailyNames),
  rows: DAILY.rows.filter((row) => row[0] !== "2026-11-14"),
};

export const TOP_VIDEOS = {
  columnHeaders: headers(topNames),
  rows: [
    [FIXTURE_VIDEO_ID, 20, 10, 4, 2],
    [FIXTURE_OTHER_VIDEO_ID, 12, 8, 3, 1],
  ],
};

export const NO_ROWS = { columnHeaders: headers(summaryNames) };
export const HEADER_MISMATCH = {
  columnHeaders: headers(["unexpectedMetric", ...summaryNames.slice(1)]),
  rows: TOTALS.rows,
};
export const EXPLICIT_NULL = {
  columnHeaders: headers(summaryNames),
  rows: [[null, 22, 3, 4, 1, 5, 2, 6]],
};
export const WRONG_WIDTH = {
  columnHeaders: headers(summaryNames),
  rows: [[11, 22, 3]],
};
export const NEGATIVE_METRIC = {
  columnHeaders: headers(summaryNames),
  rows: [[11, -1, 3, 4, 1, 5, 2, 6]],
};
export const BAD_VIDEO_ID = {
  columnHeaders: headers(topNames),
  rows: [["bad/id", 20, 10, 4, 2]],
};
export const DUPLICATE_VIDEO_ID = {
  columnHeaders: headers(topNames),
  rows: [
    [FIXTURE_VIDEO_ID, 20, 10, 4, 2],
    [FIXTURE_VIDEO_ID, 12, 8, 3, 1],
  ],
};
export const OUT_OF_WINDOW_DAY = {
  columnHeaders: headers(dailyNames),
  rows: [["2026-11-10", 1, 2, 3, 0]],
};

export const ERROR_404_VIDEO_NOT_FOUND = {
  error: { errors: [{ reason: "videoNotFound" }], message: "synthetic provider text" },
};
export const ERROR_404_OTHER = {
  error: { errors: [{ reason: "channelNotFound" }], message: "synthetic provider text" },
};
export const ERROR_400_UNSUPPORTED_QUERY = {
  error: { errors: [{ reason: "badRequest" }], message: "The query is not supported" },
};
export const ERROR_403_INSUFFICIENT_PERMISSIONS = {
  error: { errors: [{ reason: "insufficientPermissions" }], message: "synthetic provider text" },
};
export const ERROR_403_API_NOT_CONFIGURED = {
  error: { errors: [{ reason: "accessNotConfigured" }], message: "API not enabled" },
};
export const ERROR_429_QUOTA = {
  error: { errors: [{ reason: "quotaExceeded" }], message: "synthetic provider text" },
};
export const ERROR_401_AUTH = {
  error: { errors: [{ reason: "authError" }], message: "synthetic provider text" },
};
export const ERROR_503_BACKEND = {
  error: { errors: [{ reason: "backendError" }], message: "synthetic provider text" },
};

export function reportInput(videoId?: string) {
  return {
    channelId: "UCfixturechannel000000001",
    window: FIXTURE_WINDOW,
    days: FIXTURE_DAYS,
    ...(videoId ? { videoId } : {}),
  };
}
