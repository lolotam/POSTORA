import type {
  YouTubeAnalyticsBreakdownData,
  YouTubeAnalyticsDailyData,
  YouTubeAnalyticsMetric,
  YouTubeAnalyticsMetricKey,
  YouTubeAnalyticsRequestedWindow,
  YouTubeAnalyticsSummaryData,
  YouTubeAnalyticsTopVideoRow,
} from "./types";

export type YouTubeAnalyticsExportTab = "overview" | "audience" | "traffic";

export interface YouTubeAnalyticsCsvExportInput {
  tab: YouTubeAnalyticsExportTab;
  channelTitle: string;
  window: YouTubeAnalyticsRequestedWindow;
  fetchedAt: string;
  summary?: YouTubeAnalyticsSummaryData | null;
  daily?: YouTubeAnalyticsDailyData | null;
  topVideos?: readonly YouTubeAnalyticsTopVideoRow[];
  geography?: YouTubeAnalyticsBreakdownData | null;
  devices?: YouTubeAnalyticsBreakdownData | null;
  trafficSources?: YouTubeAnalyticsBreakdownData | null;
  resolveCountryLabel?: (code: string) => string;
  resolveDeviceLabel?: (key: string) => string;
  resolveTrafficSourceLabel?: (key: string) => string;
}

type CsvCell = string | number | null | undefined;

const FORMULA_PREFIX_RE = /^[=+\-@\t\r]/;
const NEEDS_QUOTING_RE = /[,"\r\n]/;

export function sanitizeCsvStringCell(value: string): string {
  return FORMULA_PREFIX_RE.test(value) ? `'${value}` : value;
}

function encodeCsvCell(cell: CsvCell): string {
  if (cell === null || cell === undefined) return "";
  const raw = typeof cell === "number"
    ? (Number.isFinite(cell) ? String(cell) : "")
    : sanitizeCsvStringCell(cell);
  if (!NEEDS_QUOTING_RE.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function encodeCsvRow(cells: readonly CsvCell[]): string {
  return cells.map(encodeCsvCell).join(",");
}

function metricValue(
  metrics: readonly YouTubeAnalyticsMetric[],
  key: YouTubeAnalyticsMetricKey,
): number | null {
  return metrics.find((metric) => metric.key === key)?.value ?? null;
}

function appendBreakdownSection(
  lines: string[],
  headers: readonly [string, string, string, string],
  data: YouTubeAnalyticsBreakdownData | null | undefined,
  resolveLabel?: (key: string) => string,
): void {
  lines.push(encodeCsvRow(headers));
  for (const row of data?.rows ?? []) {
    lines.push(encodeCsvRow([
      row.key,
      resolveLabel ? resolveLabel(row.key) : row.key,
      metricValue(row.metrics, "views"),
      metricValue(row.metrics, "watch_time"),
    ]));
  }
}

export function buildYouTubeAnalyticsCsvFilename(
  channelTitle: string,
  window: Pick<YouTubeAnalyticsRequestedWindow, "start_date" | "end_date">,
): string {
  const slug = channelTitle
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "") || "channel";
  return `youtube-analytics_${slug}_${window.start_date}_${window.end_date}.csv`;
}

export function buildYouTubeAnalyticsCsv(input: YouTubeAnalyticsCsvExportInput): string {
  const lines: string[] = [
    encodeCsvRow(["Channel", input.channelTitle]),
    encodeCsvRow(["Period", `${input.window.start_date} to ${input.window.end_date} (${input.window.days} days)`]),
    encodeCsvRow(["Time zone", input.window.time_zone]),
    encodeCsvRow(["Fetched at", input.fetchedAt]),
    "",
  ];

  if (input.tab === "overview") {
    lines.push(encodeCsvRow(["Section", "Metric", "Unit", "Value"]));
    for (const metric of input.summary?.metrics ?? []) {
      lines.push(encodeCsvRow(["Summary", metric.key, metric.unit, metric.value]));
    }
    lines.push("");
    lines.push(encodeCsvRow(["Day", "Views", "Watch time (minutes)", "Subscribers gained", "Subscribers lost"]));
    for (const row of input.daily?.rows ?? []) {
      lines.push(encodeCsvRow([
        row.day,
        metricValue(row.metrics, "views"),
        metricValue(row.metrics, "watch_time"),
        metricValue(row.metrics, "subscribers_gained"),
        metricValue(row.metrics, "subscribers_lost"),
      ]));
    }
    lines.push("");
    lines.push(encodeCsvRow([
      "Video ID",
      "Title",
      "Published at",
      "Views",
      "Watch time (minutes)",
      "Likes",
      "Subscribers gained",
    ]));
    for (const row of input.topVideos ?? []) {
      lines.push(encodeCsvRow([
        row.video_id,
        row.title,
        row.published_at,
        metricValue(row.metrics, "views"),
        metricValue(row.metrics, "watch_time"),
        metricValue(row.metrics, "likes"),
        metricValue(row.metrics, "subscribers_gained"),
      ]));
    }
  } else if (input.tab === "audience") {
    appendBreakdownSection(
      lines,
      ["Country code", "Country", "Views", "Watch time (minutes)"],
      input.geography,
      input.resolveCountryLabel,
    );
    lines.push("");
    appendBreakdownSection(
      lines,
      ["Device key", "Device", "Views", "Watch time (minutes)"],
      input.devices,
      input.resolveDeviceLabel,
    );
  } else {
    appendBreakdownSection(
      lines,
      ["Traffic source key", "Traffic source", "Views", "Watch time (minutes)"],
      input.trafficSources,
      input.resolveTrafficSourceLabel,
    );
  }

  return `\uFEFF${lines.join("\r\n")}`;
}
