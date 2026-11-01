import type { DailyMetricValue, MetricValue, UnavailableReason } from "./analyticsContract.ts";

const day = (date: string, value: number | null): DailyMetricValue => ({ date, metric: value === null
  ? { status: "unavailable", reason: "not_collected" }
  : { status: "available", value } });
type MetricCase = {
  name: string;
  input: { aggregation: "sum" | "not_summable"; days: DailyMetricValue[] };
  expected: MetricValue;
};

export const metricValueCases: MetricCase[] = [
  { name: "complete additive measurements", input: { aggregation: "sum", days: [day("2026-10-30", 3), day("2026-10-31", 5)] }, expected: { status: "available", value: 8 } },
  { name: "provider zeros", input: { aggregation: "sum", days: [day("2026-10-30", 0), day("2026-10-31", 0)] }, expected: { status: "available", value: 0 } },
  { name: "an omitted metric in an existing bucket", input: { aggregation: "sum", days: [day("2026-10-30", 0), day("2026-10-31", null)] }, expected: {
    status: "partial", value: 0, coverage: { availableDays: 1, expectedDays: 2 },
  } },
  { name: "no collected values", input: { aggregation: "sum", days: [day("2026-10-30", null)] }, expected: { status: "unavailable", reason: "not_collected" } },
  { name: "an empty window", input: { aggregation: "sum", days: [] }, expected: { status: "unavailable", reason: "not_collected" } },
  { name: "non-additive reach", input: { aggregation: "not_summable", days: [day("2026-10-30", 8), day("2026-10-31", 8)] }, expected: { status: "unavailable", reason: "window_mismatch" } },
  ...[Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY].map((value): MetricCase => ({
    name: `invalid daily measurement ${value}`, input: { aggregation: "sum", days: [day("2026-10-30", value)] }, expected: { status: "unavailable", reason: "provider_error" },
  })),
  { name: "a valid zero beside an invalid value", input: { aggregation: "sum", days: [day("2026-10-30", 0), day("2026-10-31", Number.NaN)] }, expected: { status: "partial", value: 0, coverage: { availableDays: 1, expectedDays: 2 } } },
  { name: "non-finite total", input: { aggregation: "sum", days: [day("2026-10-30", Number.MAX_VALUE), day("2026-10-31", Number.MAX_VALUE)] }, expected: { status: "unavailable", reason: "provider_error" } },
  ...(["capability_unverified", "not_offered", "permission_missing", "reauth_required", "outside_retention", "provider_error", "window_mismatch"] satisfies UnavailableReason[]).map((reason): MetricCase => ({
    name: `unavailable cause ${reason}`, input: { aggregation: "sum", days: [{ date: "2026-10-30", metric: { status: "unavailable", reason } }] }, expected: { status: "unavailable", reason },
  })),
  { name: "reconnect before uncollected days", input: { aggregation: "sum", days: [day("2026-10-30", null), { date: "2026-10-31", metric: { status: "unavailable", reason: "reauth_required" } }] }, expected: { status: "unavailable", reason: "reauth_required" } },
];

export const duplicateDayInput = { aggregation: "sum" as const, days: [day("2026-10-30", 2), day("2026-10-30", 5)] };
