import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { analyticsSyncState, metricDelta, summarizeDailyMetricValues, unavailableMetric, type AnalyticsReport } from "./analyticsContract.ts";
import { analyticsWindowForPeriod } from "./analyticsCalendar.ts";
import { analyticsReportFixture, assertAnalyticsArtifactParity, edgeAnalyticsRuntime, serializedAnalyticsArtifact } from "./analyticsContractTestSupport.ts";
import { parseAnalyticsReport } from "./analyticsSchema.ts";

Deno.test("metric aggregation preserves genuine zero, distinct causes and per-metric coverage", () => {
  const zero = { date: "2026-10-01", metric: { status: "available" as const, value: 0 } };
  assertEquals(summarizeDailyMetricValues({ aggregation: "sum", days: [zero] }), { status: "available", value: 0 });
  assertEquals(summarizeDailyMetricValues({ aggregation: "sum", days: [zero,
    { date: "2026-10-02", metric: unavailableMetric("permission_missing") }] }), { status: "partial", value: 0, coverage: { availableDays: 1, expectedDays: 2 } });
  assertEquals(summarizeDailyMetricValues({ aggregation: "sum", days: [
    { date: "2026-10-01", metric: unavailableMetric("not_collected") },
    { date: "2026-10-02", metric: unavailableMetric("reauth_required") }] }), unavailableMetric("reauth_required"));
  assertEquals(summarizeDailyMetricValues({ aggregation: "not_summable", days: [zero] }), unavailableMetric("window_mismatch"));
  assertThrows(() => summarizeDailyMetricValues({ aggregation: "sum", days: [zero, zero] }), RangeError);
  assertEquals(summarizeDailyMetricValues({ aggregation: "sum", days: [
    { date: "2026-10-01", metric: { status: "available", value: Number.MAX_SAFE_INTEGER } },
    { date: "2026-10-02", metric: { status: "available", value: 1 } }] }), unavailableMetric("provider_error"));
});

Deno.test("delta refuses zero/partial/unavailable baselines without losing a valid absolute change", () => {
  assertEquals(metricDelta({ status: "available", value: 5 }, { status: "available", value: 0 }), {
    status: "unavailable", absolute: 5, percentage: null, reason: "zero_baseline" });
  assertEquals(metricDelta({ status: "available", value: 0 }, { status: "available", value: 5 }), {
    status: "available", absolute: -5, percentage: -100, reason: null });
  assertEquals(metricDelta(unavailableMetric("permission_missing"), { status: "partial", value: 5,
    coverage: { availableDays: 1, expectedDays: 7 } }).reason, "permission_missing");
});

Deno.test("freshness uses successful persisted age, with exact threshold and explicit work states", () => {
  const input = { now: "2026-11-01T04:00:00.000Z", staleAfterSeconds: 172800, collectedAt: "2026-10-30T04:00:00.000Z",
    asOf: "2026-10-30T00:00:00.000Z", retryAt: null, syncing: false, failedReason: null, partial: false };
  assertEquals(analyticsSyncState(input).status, "fresh");
  assertEquals(analyticsSyncState({ ...input, now: "2026-11-01T04:00:00.001Z" }).status, "stale");
  assertEquals(analyticsSyncState({ ...input, collectedAt: null }).status, "never_synced");
  assertEquals(analyticsSyncState({ ...input, syncing: true }).status, "syncing");
  assertEquals(analyticsSyncState({ ...input, failedReason: "provider_error" }).status, "failed");
  assertEquals(analyticsSyncState({ ...input, partial: true }).status, "partial");
  assertThrows(() => analyticsSyncState({ ...input, staleAfterSeconds: 0 }), RangeError);
});

Deno.test("complete schema validates its actual consumer fixture and rejects discriminators, definitions and frozen windows", () => {
  const fixture = analyticsReportFixture();
  assertEquals(parseAnalyticsReport(fixture), fixture);
  assertThrows(() => parseAnalyticsReport({ ...fixture, analyticsContractVersion: 2 }), TypeError);
  assertThrows(() => parseAnalyticsReport({ ...fixture, metrics: [] }), TypeError);
  assertThrows(() => parseAnalyticsReport({ ...fixture, source: "unknown" }), TypeError);
  const mismatch = structuredClone(fixture);
  mismatch.metrics[0].definition.unit = "percent";
  assertThrows(() => parseAnalyticsReport(mismatch), TypeError);
  const shifted = structuredClone(fixture);
  shifted.period.until = "2026-10-31T00:00:00.000Z";
  assertThrows(() => parseAnalyticsReport(shifted), RangeError);
  const partial = structuredClone(fixture);
  partial.metrics[0].current = { status: "partial", value: 0, coverage: { availableDays: 0, expectedDays: 7 } };
  assertThrows(() => parseAnalyticsReport(partial), TypeError);
});

Deno.test("full schema/registry/behavior artifact rejects an isolated metadata-copy mutation", () => {
  const expected = serializedAnalyticsArtifact(edgeAnalyticsRuntime);
  const mutation = JSON.parse(expected);
  mutation.registry[0].definitionKey = "changed-definition";
  assertThrows(() => assertAnalyticsArtifactParity(JSON.stringify(mutation), expected), Error);
});

Deno.test("transport validation rejects fabricated totals, comparison, observation and persistence claims", async (test) => {
  const fixture = analyticsReportFixture();
  const visits = fixture.metrics.find((metric) => metric.definition.key === "profile_views")!;
  visits.current = { status: "available", value: 7 };
  visits.previous = { status: "available", value: 7 };
  visits.delta = metricDelta(visits.current, visits.previous);
  visits.observedAt = fixture.generatedAt;
  visits.previousObservedAt = fixture.generatedAt;
  visits.trend = analyticsWindowForPeriod(fixture.period).buckets.map((bucket) => ({ ...bucket, metric: { status: "available", value: 1 } }));
  assertEquals(parseAnalyticsReport(fixture), fixture);
  const cases: { name: string; mutate: (report: AnalyticsReport) => void }[] = [
    { name: "missing observation", mutate: (report) => { report.metrics[1].observedAt = null; } },
    { name: "future observation", mutate: (report) => { report.metrics[1].observedAt = "2099-01-01T00:00:00Z"; } },
    { name: "false delta", mutate: (report) => { report.metrics[1].delta.percentage = 100; } },
    { name: "false total", mutate: (report) => { report.metrics[1].current = { status: "available", value: 10 }; } },
    { name: "wrong coverage", mutate: (report) => { report.metrics[1].current = { status: "partial", value: 6, coverage: { availableDays: 6, expectedDays: 14 } }; } },
    { name: "missing daily series", mutate: (report) => { report.metrics[1].trend = []; } },
    { name: "invalid daily count hidden by an unavailable total", mutate: (report) => {
      const metric = report.metrics[1];
      metric.trend[0].metric = { status: "available", value: -1 };
      metric.current = unavailableMetric("provider_error");
      metric.delta = metricDelta(metric.current, metric.previous);
    } },
    { name: "false live persistence", mutate: (report) => { report.sync = { ...report.sync, status: "fresh", collectedAt: report.generatedAt }; } },
    { name: "false persisted freshness", mutate: (report) => { report.source = "persisted"; report.sync = { ...report.sync, status: "fresh",
      collectedAt: "2026-10-01T04:00:00Z", asOf: "2026-10-01T00:00:00Z" }; } },
    { name: "invented boundary sample", mutate: (report) => { report.metrics[1].boundaryObservations.current = {
      start: { observedAt: report.period.since, value: 1 }, end: { observedAt: report.period.until, value: 7 } }; } },
  ];
  for (const { name, mutate } of cases) await test.step(name, () => {
    const changed = structuredClone(fixture);
    mutate(changed);
    assertThrows(() => parseAnalyticsReport(changed), TypeError);
  });
  const refreshedEvidence = structuredClone(fixture);
  refreshedEvidence.metrics[1].definition.verifiedAt = "2026-11-02T00:00:00Z";
  refreshedEvidence.metrics[1].definition.evidenceRef = "docs/journeys/refreshed-evidence.md";
  assertEquals(parseAnalyticsReport(refreshedEvidence), refreshedEvidence);
});
