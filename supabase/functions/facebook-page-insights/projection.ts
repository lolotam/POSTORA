import { unavailableMetric, summarizeDailyMetricValues, type AnalyticsMetricResult, type MetricDefinition, type MetricValue, type UnavailableReason } from "../_shared/analyticsContract.ts";
import { alignedDailySeries, countMetric, liveAnalyticsMetric, type CompleteAnalyticsMetric } from "../_shared/analyticsProjection.ts";
import type { AnalyticsCalendarWindow } from "../_shared/analyticsCalendar.ts";
import type { FacebookMetricRow, FacebookRead, FacebookReadReason } from "./provider.ts";

export type FacebookMetricReply = FacebookRead<{ data: FacebookMetricRow[] }>;
export function facebookUnavailableReason(reason: FacebookReadReason): UnavailableReason {
  return reason === "rate_limited" ? "provider_error" : reason;
}

function rowFor(reply: FacebookMetricReply | undefined, definition: MetricDefinition, period: "day" | "lifetime"): FacebookMetricRow | CompleteAnalyticsMetric {
  if (!reply) return unavailableMetric("not_collected");
  if (reply.error) return unavailableMetric(facebookUnavailableReason(reply.error.reason));
  const rows = reply.data.data.filter((row) => row.name === definition.providerMetric && row.period === period);
  return rows.length === 1 ? rows[0] : unavailableMetric("provider_error");
}

function dailyMeasurement(reply: FacebookMetricReply | undefined, definition: MetricDefinition, window: AnalyticsCalendarWindow) {
  const row = rowFor(reply, definition, "day");
  if ("status" in row) return { metric: row as MetricValue, series: [] as CompleteAnalyticsMetric[] };
  const series = alignedDailySeries(row, window);
  const metric = definition.aggregation === "last" ? series[series.length - 1]
    : summarizeDailyMetricValues({ aggregation: definition.aggregation === "sum" ? "sum" : "not_summable",
      days: window.buckets.map((bucket, index) => ({ date: bucket.date, metric: series[index] })) });
  return { metric, series };
}

export function projectFacebookAccountMetric(input: {
  definition: MetricDefinition; current: FacebookMetricReply | undefined; previous: FacebookMetricReply | undefined;
  windows: { current: AnalyticsCalendarWindow; previous: AnalyticsCalendarWindow }; observedAt: string;
}): AnalyticsMetricResult {
  const { definition } = input;
  const reason = definition.capability === "not_offered" ? "not_offered" : "capability_unverified";
  const current = definition.capability === "available" ? dailyMeasurement(input.current, definition, input.windows.current)
    : { metric: unavailableMetric(reason), series: [] };
  const previous = definition.capability === "available" ? dailyMeasurement(input.previous, definition, input.windows.previous).metric : unavailableMetric(reason);
  return liveAnalyticsMetric({ definition, current: current.metric, previous,
    observedAt: definition.capability === "available" && input.current && !input.current.error ? input.observedAt : null,
    previousObservedAt: definition.capability === "available" && input.previous && !input.previous.error ? input.observedAt : null,
    trend: current.series.map((metric, index) => ({ ...input.windows.current.buckets[index], metric })),
  });
}

export function projectFacebookPostMetric(definition: MetricDefinition, reply: FacebookMetricReply | undefined, observedAt: string): AnalyticsMetricResult {
  const capabilityReason = definition.capability === "not_offered" ? "not_offered" : "capability_unverified";
  let current: MetricValue = unavailableMetric(capabilityReason);
  if (definition.capability === "available") {
    const row = rowFor(reply, definition, "lifetime");
    current = "status" in row ? row : row.values?.length === 1 ? countMetric(row.values[0].value) : unavailableMetric("provider_error");
  }
  return liveAnalyticsMetric({ definition, current, previous: unavailableMetric(definition.capability === "available" ? "not_collected" : capabilityReason),
    observedAt: current.status === "available" ? observedAt : null, previousObservedAt: null, trend: [] });
}
