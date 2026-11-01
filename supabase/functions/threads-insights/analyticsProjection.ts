import {
  metricDelta, summarizeDailyMetricValues, unavailableMetric,
  type AnalyticsMetricResult, type MetricDefinition, type MetricValue, type UnavailableReason,
} from "../_shared/analyticsContract.ts";
import type { AnalyticsCalendarWindow } from "../_shared/analyticsCalendar.ts";
import type { ProviderResult, ThreadsMetricRow, ThreadsProviderError } from "./provider.ts";

type MetricReply = ProviderResult<{ data: ThreadsMetricRow[] }>;
type CompleteMetric = Exclude<MetricValue, { status: "partial" }>;

export function threadsUnavailableReason(error: ThreadsProviderError): UnavailableReason {
  if (error.reason === "expired_token" || error.reason === "invalid_token") return "reauth_required";
  if (error.reason === "missing_scope" || error.reason === "permission_not_approved") return "permission_missing";
  return "provider_error";
}

function count(value: number | null | undefined): CompleteMetric {
  return Number.isSafeInteger(value) && value! >= 0 ? { status: "available", value: value! } : unavailableMetric("provider_error");
}

function matchingRow(reply: MetricReply, definition: MetricDefinition): ThreadsMetricRow | CompleteMetric {
  if (reply.error) return unavailableMetric(threadsUnavailableReason(reply.error));
  const rows = reply.data.data.filter((row) => row.name === definition.providerMetric);
  return rows.length === 1 ? rows[0] : unavailableMetric("provider_error");
}

function dailySeries(row: ThreadsMetricRow, window: AnalyticsCalendarWindow): CompleteMetric[] {
  const refused = (reason: UnavailableReason) => window.buckets.map(() => unavailableMetric(reason));
  if (row.period !== "day" || !row.values) return refused("window_mismatch");
  const expectedEnds = new Set(window.buckets.map((bucket) => Date.parse(bucket.until)));
  const points = new Map<number, CompleteMetric>();
  for (const point of row.values) {
    const end = point.end_time ? Date.parse(point.end_time) : NaN;
    if (!Number.isFinite(end)) return refused("window_mismatch");
    if (end <= Date.parse(window.period.since) || end > Date.parse(window.period.until)) continue;
    if (!expectedEnds.has(end)) return refused("window_mismatch");
    points.set(end, points.has(end) ? unavailableMetric("provider_error") : count(point.value));
  }
  return window.buckets.map((bucket) => points.get(Date.parse(bucket.until)) ?? unavailableMetric("provider_error"));
}

function periodMeasurement(reply: MetricReply, definition: MetricDefinition, window: AnalyticsCalendarWindow): {
  metric: MetricValue; series: CompleteMetric[];
} {
  const row = matchingRow(reply, definition);
  if ("status" in row) return { metric: row, series: [] };
  if (definition.windowKind === "point_in_time") return {
    metric: row.period === "day" ? count(row.total_value?.value) : unavailableMetric("window_mismatch"), series: [],
  };
  if (definition.windowKind !== "day" || definition.aggregation !== "sum" || !definition.exactPeriodVerified) {
    return { metric: unavailableMetric("window_mismatch"), series: [] };
  }
  const series = dailySeries(row, window);
  return { metric: summarizeDailyMetricValues({ aggregation: "sum",
    days: window.buckets.map((bucket, index) => ({ date: bucket.date, metric: series[index] })) }), series };
}

export function projectThreadsAccountMetric(input: {
  definition: MetricDefinition; current: MetricReply; previous: MetricReply;
  windows: { current: AnalyticsCalendarWindow; previous: AnalyticsCalendarWindow }; observedAt: string;
}): AnalyticsMetricResult {
  const { definition } = input;
  const capabilityReason = definition.capability === "unverified" ? "capability_unverified" : "not_offered";
  const current = definition.capability === "available" ? periodMeasurement(input.current, definition, input.windows.current)
    : { metric: unavailableMetric(capabilityReason), series: [] };
  const previous = definition.capability !== "available" ? unavailableMetric(capabilityReason)
    : definition.windowKind === "point_in_time" ? unavailableMetric("not_collected")
    : periodMeasurement(input.previous, definition, input.windows.previous).metric;
  return {
    definition, current: current.metric, previous, delta: metricDelta(current.metric, previous),
    observedAt: definition.capability === "available" && !input.current.error ? input.observedAt : null,
    previousObservedAt: definition.capability === "available" && definition.windowKind !== "point_in_time" && !input.previous.error ? input.observedAt : null,
    boundaryObservations: { current: null, previous: null },
    trend: current.series.map((metric, index) => ({ ...input.windows.current.buckets[index], metric })),
  };
}

export function projectThreadsPostMetric(definition: MetricDefinition, reply: MetricReply, observedAt: string): AnalyticsMetricResult {
  let current: MetricValue = unavailableMetric(definition.capability === "not_offered" ? "not_offered" : "capability_unverified");
  if (definition.capability === "available") {
    const row = matchingRow(reply, definition);
    current = "status" in row ? row : row.period !== "lifetime" ? unavailableMetric("window_mismatch")
      : row.values?.length === 1 ? count(row.values[0].value) : unavailableMetric("provider_error");
  }
  const previous = unavailableMetric(definition.capability === "available" ? "not_collected"
    : definition.capability === "not_offered" ? "not_offered" : "capability_unverified");
  return { definition, current, previous, delta: metricDelta(current, previous), trend: [],
    observedAt: current.status === "available" ? observedAt : null, previousObservedAt: null,
    boundaryObservations: { current: null, previous: null } };
}
