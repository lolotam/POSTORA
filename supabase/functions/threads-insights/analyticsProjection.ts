import {
  summarizeDailyMetricValues, unavailableMetric,
  type AnalyticsMetricResult, type MetricDefinition, type MetricValue, type UnavailableReason,
} from "../_shared/analyticsContract.ts";
import { countMetric as count, alignedDailySeries as dailySeries, liveAnalyticsMetric, type DailyAnalyticsRow } from "../_shared/analyticsProjection.ts";
import type { AnalyticsCalendarWindow } from "../_shared/analyticsCalendar.ts";
import type { ProviderResult, ThreadsMetricRow, ThreadsProviderError } from "./provider.ts";

type MetricReply = ProviderResult<{ data: ThreadsMetricRow[] }>;
type CompleteMetric = Exclude<MetricValue, { status: "partial" }>;

/** Snapshot endpoints may omit period; explicit incompatible periods still refuse. */
export function threadsSnapshotMetric(row: DailyAnalyticsRow & Pick<ThreadsMetricRow, "total_value">, windowKind: "point_in_time" | "lifetime"): CompleteMetric {
  const expectedPeriod = windowKind === "point_in_time" ? "day" : "lifetime";
  if (row.period !== undefined && row.period !== expectedPeriod) return unavailableMetric("window_mismatch");
  if (row.total_value !== undefined) return count(row.total_value.value);
  return windowKind === "lifetime" && row.values?.length === 1 ? count(row.values[0].value) : unavailableMetric("provider_error");
}

export function threadsUnavailableReason(error: ThreadsProviderError): UnavailableReason {
  if (error.reason === "expired_token" || error.reason === "invalid_token") return "reauth_required";
  if (error.reason === "missing_scope" || error.reason === "permission_not_approved") return "permission_missing";
  return "provider_error";
}

function matchingRow(reply: MetricReply, definition: MetricDefinition): ThreadsMetricRow | CompleteMetric {
  if (reply.error) return unavailableMetric(threadsUnavailableReason(reply.error));
  const rows = reply.data.data.filter((row) => row.name === definition.providerMetric);
  return rows.length === 1 ? rows[0] : unavailableMetric("provider_error");
}

function periodMeasurement(reply: MetricReply, definition: MetricDefinition, window: AnalyticsCalendarWindow): {
  metric: MetricValue; series: CompleteMetric[];
} {
  const row = matchingRow(reply, definition);
  if ("status" in row) return { metric: row, series: [] };
  if (definition.windowKind === "point_in_time") return {
    metric: threadsSnapshotMetric(row, "point_in_time"), series: [],
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
  return liveAnalyticsMetric({
    definition, current: current.metric, previous,
    observedAt: definition.capability === "available" && !input.current.error ? input.observedAt : null,
    previousObservedAt: definition.capability === "available" && definition.windowKind !== "point_in_time" && !input.previous.error ? input.observedAt : null,
    trend: current.series.map((metric, index) => ({ ...input.windows.current.buckets[index], metric })),
  });
}

export function projectThreadsPostMetric(definition: MetricDefinition, reply: MetricReply, observedAt: string): AnalyticsMetricResult {
  let current: MetricValue = unavailableMetric(definition.capability === "not_offered" ? "not_offered" : "capability_unverified");
  if (definition.capability === "available") {
    const row = matchingRow(reply, definition);
    current = "status" in row ? row : threadsSnapshotMetric(row, "lifetime");
  }
  const previous = unavailableMetric(definition.capability === "available" ? "not_collected"
    : definition.capability === "not_offered" ? "not_offered" : "capability_unverified");
  return liveAnalyticsMetric({ definition, current, previous, trend: [],
    observedAt: current.status === "available" ? observedAt : null, previousObservedAt: null,
  });
}
