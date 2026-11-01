/** One runtime-neutral contract is imported by the browser and Edge Functions. */
import type { AnalyticsDayBucket, AnalyticsPeriod } from "./analyticsCalendar.ts";

export const ANALYTICS_CONTRACT_VERSION = 1 as const;
export const ANALYTICS_PLATFORMS = ["instagram", "facebook", "threads"] as const;
export type AnalyticsPlatform = typeof ANALYTICS_PLATFORMS[number];

export const UNAVAILABLE_REASONS = [
  "reauth_required", "permission_missing", "provider_error", "window_mismatch",
  "outside_retention", "capability_unverified", "not_offered", "not_collected",
] as const;
export type UnavailableReason = typeof UNAVAILABLE_REASONS[number];
export type MetricCoverage = { availableDays: number; expectedDays: number };
export type MetricValue =
  | { status: "available"; value: number }
  | { status: "partial"; value: number; coverage: MetricCoverage }
  | { status: "unavailable"; reason: UnavailableReason };
export type DailyMetricValue = { date: string; metric: Exclude<MetricValue, { status: "partial" }> };
export const ANALYTICS_METRIC_KEYS = [
  "views", "profile_views", "reach", "unique_viewers", "impressions", "engagements",
  "likes", "comments", "replies", "shares", "reposts", "quotes", "saves", "followers", "follower_change",
] as const;
export type AnalyticsMetricKey = typeof ANALYTICS_METRIC_KEYS[number];
export type AnalyticsMetricLevel = "account" | "post";

export type MetricDefinition = {
  key: AnalyticsMetricKey;
  platform: AnalyticsPlatform;
  level: AnalyticsMetricLevel;
  providerMetric: string | null;
  apiVersion: string;
  unit: "count" | "accounts" | "percent";
  windowKind: "day" | "period_total" | "lifetime" | "point_in_time";
  aggregation: "sum" | "last" | "not_summable";
  providerBucketTimezone: string | null;
  definitionKey: string;
  minimumPermission: string | null;
  capability: "unverified" | "available" | "not_offered";
  evidenceRef: string | null;
  verifiedAt: string | null;
  exactPeriodVerified: boolean;
};

export type AnalyticsMetricDelta = {
  status: "available" | "unavailable";
  absolute: number | null;
  percentage: number | null;
  reason: UnavailableReason | "incomplete_period" | "zero_baseline" | null;
};
export type AnalyticsBoundaryObservations = {
  start: { observedAt: string; value: number };
  end: { observedAt: string; value: number };
};
export type AnalyticsMetricResult = {
  definition: MetricDefinition;
  current: MetricValue;
  previous: MetricValue;
  delta: AnalyticsMetricDelta;
  observedAt: string | null;
  previousObservedAt: string | null;
  boundaryObservations: { current: AnalyticsBoundaryObservations | null; previous: AnalyticsBoundaryObservations | null };
  trend: (AnalyticsDayBucket & { metric: Exclude<MetricValue, { status: "partial" }> })[];
};
export type AnalyticsSyncState = {
  status: "never_synced" | "syncing" | "fresh" | "stale" | "partial" | "failed";
  reason: UnavailableReason | null;
  asOf: string | null;
  collectedAt: string | null;
  retryAt: string | null;
};
export type AnalyticsPost = {
  id: string;
  publishedAt: string;
  text: string;
  permalink: string | null;
  metrics: AnalyticsMetricResult[];
};
export type AnalyticsReport = {
  analyticsContractVersion: typeof ANALYTICS_CONTRACT_VERSION;
  platform: AnalyticsPlatform;
  accountId: string;
  generatedAt: string;
  period: AnalyticsPeriod;
  previousPeriod: AnalyticsPeriod;
  source: "live" | "persisted";
  metrics: AnalyticsMetricResult[];
  posts: {
    items: AnalyticsPost[]; nextCursor: string | null; truncated: boolean;
    status: "available" | "partial" | "unavailable"; reason: UnavailableReason | null;
  };
  sync: AnalyticsSyncState;
  truncated: boolean;
  lastPartialAt: string | null;
  retryAt: string | null;
};

export function unavailableMetric(reason: UnavailableReason): Extract<MetricValue, { status: "unavailable" }> {
  return { status: "unavailable", reason };
}

/** Intentionally unsupported aggregates are capability gaps, not failed collection of a measurable value. */
export function isAnalyticsMetricMeasurable(definition: MetricDefinition): boolean {
  return definition.capability === "available"
    && !(definition.windowKind === "period_total" && !definition.exactPeriodVerified)
    && !(definition.windowKind === "day" && definition.aggregation === "not_summable");
}

function missingReason(metrics: readonly MetricValue[]): UnavailableReason {
  const reasons = new Set(metrics.flatMap((metric) => metric.status === "unavailable" ? [metric.reason] : []));
  return UNAVAILABLE_REASONS.find((reason) => reasons.has(reason)) ?? "not_collected";
}

/** Supply one resolved observation for each expected day; captures and retries never create additional days. */
export function summarizeDailyMetricValues(input: { aggregation: "sum" | "not_summable"; days: readonly DailyMetricValue[] }): MetricValue {
  if (input.aggregation === "not_summable") return unavailableMetric("window_mismatch");
  if (new Set(input.days.map((day) => day.date)).size !== input.days.length) throw new RangeError("Resolve duplicate metric dates before aggregation");
  const metrics = input.days.map((day) => day.metric.status === "available" && (!Number.isSafeInteger(day.metric.value) || day.metric.value < 0)
    ? unavailableMetric("provider_error") : day.metric);
  const values = metrics.flatMap((metric) => metric.status === "available" ? [metric.value] : []);
  if (!values.length) return unavailableMetric(missingReason(metrics));
  const total = values.reduce((sum, measurement) => sum + measurement, 0);
  if (!Number.isSafeInteger(total)) return unavailableMetric("provider_error");
  return values.length === input.days.length ? { status: "available", value: total }
    : { status: "partial", value: total, coverage: { availableDays: values.length, expectedDays: input.days.length } };
}

export function metricDelta(current: MetricValue, previous: MetricValue): AnalyticsMetricDelta {
  if (current.status !== "available" || previous.status !== "available") {
    return { status: "unavailable", absolute: null, percentage: null,
      reason: current.status === "unavailable" || previous.status === "unavailable" ? missingReason([current, previous]) : "incomplete_period" };
  }
  const absolute = current.value - previous.value;
  const percentage = previous.value === 0 ? null : absolute / previous.value * 100;
  if (!Number.isFinite(absolute) || percentage !== null && !Number.isFinite(percentage)) {
    return { status: "unavailable", absolute: null, percentage: null, reason: "provider_error" };
  }
  return { status: previous.value === 0 ? "unavailable" : "available", absolute, percentage,
    reason: previous.value === 0 ? "zero_baseline" : null };
}

export function analyticsSyncState(input: {
  now: string; staleAfterSeconds: number; collectedAt: string | null; asOf: string | null; retryAt: string | null;
  syncing: boolean; failedReason: UnavailableReason | null; partial: boolean;
}): AnalyticsSyncState {
  if (!Number.isFinite(Date.parse(input.now)) || !Number.isSafeInteger(input.staleAfterSeconds) || input.staleAfterSeconds <= 0) {
    throw new RangeError("Invalid analytics freshness configuration");
  }
  const common = { asOf: input.asOf, collectedAt: input.collectedAt, retryAt: input.retryAt };
  if (input.syncing) return { ...common, status: "syncing", reason: null };
  if (input.failedReason) return { ...common, status: "failed", reason: input.failedReason };
  if (input.partial) return { ...common, status: "partial", reason: null };
  if (!input.collectedAt) return { ...common, asOf: null, status: "never_synced", reason: null };
  const age = Date.parse(input.now) - Date.parse(input.collectedAt);
  if (!Number.isFinite(age) || age < 0 || !Number.isSafeInteger(input.staleAfterSeconds) || input.staleAfterSeconds <= 0) {
    throw new RangeError("Invalid analytics freshness inputs");
  }
  return { ...common, status: age > input.staleAfterSeconds * 1000 ? "stale" : "fresh", reason: null };
}
