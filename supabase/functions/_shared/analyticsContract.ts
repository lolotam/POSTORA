/** Runtime-neutral metric foundation. No provider, SDK, UI or environment dependencies. */
const unavailableReasonPriority = [
  "reauth_required", "permission_missing", "provider_error", "window_mismatch",
  "outside_retention", "capability_unverified", "not_offered", "not_collected",
] as const;

export type UnavailableReason = typeof unavailableReasonPriority[number];
export type MetricCoverage = { availableDays: number; expectedDays: number };
export type MetricValue =
  | { status: "available"; value: number }
  | { status: "partial"; value: number; coverage: MetricCoverage }
  | { status: "unavailable"; reason: UnavailableReason };

export type DailyMetricValue = {
  date: string;
  metric: Exclude<MetricValue, { status: "partial" }>;
};

function finiteDailyMetric(day: DailyMetricValue): DailyMetricValue["metric"] {
  return day.metric.status === "available" && !Number.isFinite(day.metric.value)
    ? { status: "unavailable", reason: "provider_error" } : day.metric;
}

function missingMetricReason(metrics: readonly DailyMetricValue["metric"][]): UnavailableReason {
  const reasons = new Set(metrics.flatMap((metric) => metric.status === "unavailable" ? [metric.reason] : []));
  // A reconnect/permission failure must remain actionable when other days have never been collected.
  return unavailableReasonPriority.find((reason) => reasons.has(reason)) ?? "not_collected";
}

/**
 * Callers supply one resolved observation for every expected provider-day bucket,
 * including unavailable buckets. Resolve captures/retries before calling this function.
 * Non-additive totals require an exact provider-period measurement on a separate path.
 */
export function summarizeDailyMetricValues(input: {
  aggregation: "sum" | "not_summable";
  days: readonly DailyMetricValue[];
}): MetricValue {
  if (input.aggregation === "not_summable") return { status: "unavailable", reason: "window_mismatch" };
  if (new Set(input.days.map((day) => day.date)).size !== input.days.length) {
    throw new RangeError("Resolve duplicate metric dates before aggregation");
  }
  const metrics = input.days.map(finiteDailyMetric);
  const measurements = metrics.flatMap((metric) => metric.status === "available" ? [metric.value] : []);
  if (!measurements.length) return { status: "unavailable", reason: missingMetricReason(metrics) };
  const total = measurements.reduce((sum, measurement) => sum + measurement, 0);
  if (!Number.isFinite(total)) return { status: "unavailable", reason: "provider_error" };
  return measurements.length === input.days.length ? { status: "available", value: total }
    : { status: "partial", value: total, coverage: { availableDays: measurements.length, expectedDays: input.days.length } };
}
