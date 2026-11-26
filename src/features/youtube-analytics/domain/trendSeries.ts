import { YOUTUBE_ANALYTICS_DAILY_METRICS, type YouTubeAnalyticsDailyRow, type YouTubeAnalyticsMetricKey, type YouTubeAnalyticsRequestedWindow } from "./types";

export type YouTubeAnalyticsTrendPoint = {
  day: string;
} & Record<"views" | "watch_time" | "subscribers_gained" | "subscribers_lost", number | null>;

function emptyPoint(day: string): YouTubeAnalyticsTrendPoint {
  return {
    day,
    views: null,
    watch_time: null,
    subscribers_gained: null,
    subscribers_lost: null,
  };
}

export function buildTrendSeries(
  requestedWindow: Pick<YouTubeAnalyticsRequestedWindow, "start_date" | "end_date" | "days">,
  rows: YouTubeAnalyticsDailyRow[],
): YouTubeAnalyticsTrendPoint[] {
  const rowsByDay = new Map(rows.map((row) => [row.day, row]));
  const cursor = new Date(`${requestedWindow.start_date}T00:00:00Z`);
  const points: YouTubeAnalyticsTrendPoint[] = [];

  for (let index = 0; index < requestedWindow.days; index += 1) {
    const day = cursor.toISOString().slice(0, 10);
    const point = emptyPoint(day);
    const row = rowsByDay.get(day);
    for (const definition of YOUTUBE_ANALYTICS_DAILY_METRICS) {
      const key = definition.key as Extract<YouTubeAnalyticsMetricKey, keyof YouTubeAnalyticsTrendPoint>;
      point[key] = row?.metrics.find((metric) => metric.key === key)?.value ?? null;
    }
    points.push(point);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }

  return points;
}
