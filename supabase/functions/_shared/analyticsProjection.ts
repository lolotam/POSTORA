import { metricDelta, unavailableMetric, type AnalyticsMetricResult, type MetricValue, type UnavailableReason } from "./analyticsContract.ts";
import type { AnalyticsCalendarWindow } from "./analyticsCalendar.ts";

export type CompleteAnalyticsMetric = Exclude<MetricValue, { status: "partial" }>;
export type DailyAnalyticsRow = { period?: string; values?: { value?: number | null; end_time?: string }[] };

export function countMetric(value: number | null | undefined): CompleteAnalyticsMetric {
  return Number.isSafeInteger(value) && value! >= 0 ? { status: "available", value: value! } : unavailableMetric("provider_error");
}

/** Provider calendars may include an extra boundary bucket. Only the exact expected end instants are usable. */
export function alignedDailySeries(row: DailyAnalyticsRow, window: AnalyticsCalendarWindow): CompleteAnalyticsMetric[] {
  const refused = (reason: UnavailableReason) => window.buckets.map(() => unavailableMetric(reason));
  if (row.period !== "day" || !row.values) return refused("window_mismatch");
  const expectedEnds = new Set(window.buckets.map((bucket) => Date.parse(bucket.until)));
  const points = new Map<number, CompleteAnalyticsMetric>();
  for (const point of row.values) {
    const end = point.end_time ? Date.parse(point.end_time) : NaN;
    if (!Number.isFinite(end)) return refused("window_mismatch");
    if (end <= Date.parse(window.period.since) || end > Date.parse(window.period.until)) continue;
    if (!expectedEnds.has(end)) return refused("window_mismatch");
    points.set(end, points.has(end) ? unavailableMetric("provider_error") : countMetric(point.value));
  }
  return window.buckets.map((bucket) => points.get(Date.parse(bucket.until)) ?? unavailableMetric("provider_error"));
}

export function liveAnalyticsMetric(input: Omit<AnalyticsMetricResult, "delta" | "boundaryObservations">): AnalyticsMetricResult {
  return { ...input, delta: metricDelta(input.current, input.previous), boundaryObservations: { current: null, previous: null } };
}
