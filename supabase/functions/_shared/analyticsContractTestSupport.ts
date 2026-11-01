import * as contract from "./analyticsContract.ts";
import * as calendar from "./analyticsCalendar.ts";
import * as registry from "./analyticsRegistry.ts";
import * as schema from "./analyticsSchema.ts";

export const edgeAnalyticsRuntime = { ...contract, ...calendar, ...registry, ...schema };
type AnalyticsRuntime = typeof edgeAnalyticsRuntime;

export function analyticsReportFixture(): contract.AnalyticsReport {
  const windows = calendar.closedAnalyticsPeriods({ now: "2026-11-01T04:00:00Z", days: 7, timezone: "America/Los_Angeles" });
  const metrics = registry.analyticsDefinitions("threads", "account").map((definition) => {
    const current = contract.unavailableMetric(definition.capability === "available" ? "provider_error" : "capability_unverified");
    const previous = contract.unavailableMetric(definition.capability === "available" && definition.windowKind === "point_in_time" ? "not_collected" : current.reason);
    return { definition, current, previous, delta: contract.metricDelta(current, previous), observedAt: null,
      previousObservedAt: null, boundaryObservations: { current: null, previous: null }, trend: [] };
  });
  return {
    analyticsContractVersion: 1, platform: "threads", accountId: "9f020000-0000-4000-8000-000000000001", generatedAt: "2026-11-01T04:00:00.000Z",
    period: windows.current.period, previousPeriod: windows.previous.period, source: "live", metrics,
    posts: { items: [], status: "available", reason: null, nextCursor: null, truncated: false },
    sync: { status: "never_synced", reason: null, collectedAt: null, asOf: null, retryAt: null },
    truncated: false, lastPartialAt: "2026-11-01T04:00:00.000Z", retryAt: null,
  };
}

function rejected(runtime: AnalyticsRuntime, value: unknown): boolean {
  try { runtime.parseAnalyticsReport(value); return false; }
  catch (error) { if (error instanceof TypeError || error instanceof RangeError) return true; throw error; }
}

/** Real public runtime symbols exercise the same fixtures in Vitest and Deno. */
export function serializedAnalyticsArtifact(runtime: AnalyticsRuntime): string {
  const calendarCases = [
    { now: "2026-03-10T03:00:00Z", days: 7 as const, timezone: "America/Los_Angeles" },
    { now: "2026-11-03T03:00:00Z", days: 7 as const, timezone: "America/Los_Angeles" },
    { now: "2024-03-03T12:00:00Z", days: 7 as const, timezone: "UTC" },
    { now: "2026-01-03T12:00:00Z", days: 14 as const, timezone: "Asia/Kuwait" },
    { now: "2026-11-01T04:00:00Z", days: 30 as const, timezone: "America/Los_Angeles" },
    { now: "2026-11-01T04:00:00Z", days: 90 as const, timezone: "America/Los_Angeles" },
  ];
  const available = (value: number): Extract<contract.MetricValue, { status: "available" }> => ({ status: "available", value });
  const refused = runtime.unavailableMetric("permission_missing");
  const report = analyticsReportFixture();
  return JSON.stringify({
    schema: runtime.ANALYTICS_REPORT_SCHEMA, registry: runtime.ANALYTICS_METRIC_REGISTRY, configuration: runtime.ANALYTICS_PLATFORM_CONFIGURATION,
    version: runtime.ANALYTICS_CONTRACT_VERSION, reasons: runtime.UNAVAILABLE_REASONS, platforms: runtime.ANALYTICS_PLATFORMS,
    metricKeys: runtime.ANALYTICS_METRIC_KEYS, periodDays: runtime.ANALYTICS_PERIOD_DAYS,
    calendar: calendarCases.map((input) => runtime.closedAnalyticsPeriods(input)),
    values: [
      runtime.summarizeDailyMetricValues({ aggregation: "sum", days: [{ date: "2026-10-01", metric: available(0) }] }),
      runtime.summarizeDailyMetricValues({ aggregation: "sum", days: [{ date: "2026-10-01", metric: available(4) }, { date: "2026-10-02", metric: refused }] }),
      runtime.summarizeDailyMetricValues({ aggregation: "not_summable", days: [{ date: "2026-10-01", metric: available(4) }] }),
    ],
    deltas: [runtime.metricDelta(available(0), available(5)), runtime.metricDelta(available(5), available(0)), runtime.metricDelta(available(5), refused)],
    freshness: [0, 1].map((millisecond) => runtime.analyticsSyncState({ now: new Date(Date.parse("2026-11-01T04:00:00Z") + millisecond).toISOString(),
      staleAfterSeconds: 172800, collectedAt: "2026-10-30T04:00:00Z", asOf: "2026-10-30T00:00:00Z", retryAt: null, syncing: false, failedReason: null, partial: false })),
    report: runtime.parseAnalyticsReport(report), invalidVersionRejected: rejected(runtime, { ...report, analyticsContractVersion: 2 }),
    missingFieldsRejected: rejected(runtime, { ...report, metrics: [] }),
  });
}

export function assertAnalyticsArtifactParity(actual: string, expected: string): void {
  if (actual !== expected) throw new Error("Complete analytics schema, registry or behavior parity failed");
}
