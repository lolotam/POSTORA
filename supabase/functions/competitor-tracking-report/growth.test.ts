/**
 * The growth projection of the competitor tracking report.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - The approved staleness is a SERVER constant of three days, and it is
 *     the constant the report is measured against.
 *   - A refused comparison carries null outputs and an explicit reason. It
 *     never carries zero and never carries Infinity.
 *   - A negative change is a valid change.
 *   - The reported interval is the ACTUAL interval, not the requested one.
 *   - A baseline the database returned is still checked against the server's
 *     own window, so a widened database window cannot publish a stale
 *     comparison.
 *   - Without an approved policy no comparison is published at all.
 *   - A non-finite or unsafe number is refused rather than rounded.
 */

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  CompetitorReportContractError,
  type RawGrowth,
} from "./contracts.ts";
import {
  COMPETITOR_REPORT_BASELINE_POLICY,
  COMPETITOR_REPORT_MAX_STALENESS_SECONDS,
  assertBaselinePolicy,
  mapGrowth,
} from "./growth.ts";

/** A comparable seven-day comparison. */
function comparable(overrides: Partial<RawGrowth> = {}): RawGrowth {
  return {
    period_days: 7,
    reason: null,
    observed_at: "2026-10-20T12:00:00+00:00",
    observed_followers: 1000,
    observed_source: "official",
    baseline_at: "2026-10-13T12:00:00+00:00",
    baseline_followers: 900,
    interval_days: 7,
    interval_seconds: 604800,
    absolute: 100,
    percent: 11.111111,
    ...overrides,
  };
}

/** A refused comparison. */
function refused(reason: string, overrides: Partial<RawGrowth> = {}): RawGrowth {
  return {
    period_days: 7,
    reason,
    observed_at: "2026-10-20T12:00:00+00:00",
    observed_followers: 1000,
    observed_source: "official",
    baseline_at: null,
    baseline_followers: null,
    interval_days: null,
    interval_seconds: null,
    absolute: null,
    percent: null,
    ...overrides,
  };
}

Deno.test("the approved staleness is three days and it lives on the server", () => {
  assertEquals(COMPETITOR_REPORT_MAX_STALENESS_SECONDS, 259_200);
  assertEquals(COMPETITOR_REPORT_MAX_STALENESS_SECONDS, 3 * 86_400);
  assertEquals(COMPETITOR_REPORT_BASELINE_POLICY.maxStalenessSeconds, 259_200);
});

Deno.test("a comparable comparison keeps its numbers", () => {
  const growth = mapGrowth(comparable(), 7, COMPETITOR_REPORT_BASELINE_POLICY);

  assertEquals(growth.reason, null);
  assertEquals(growth.absolute, 100);
  assertEquals(growth.percent, 11.111111);
  assertEquals(growth.baseline_at, "2026-10-13T12:00:00+00:00");
  assertEquals(growth.observed_at, "2026-10-20T12:00:00+00:00");
  assertEquals(growth.interval_days, 7);
});

Deno.test("a missing baseline refuses the comparison", () => {
  const growth = mapGrowth(
    refused("no_comparable_baseline"),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "missing_baseline");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
  assertEquals(growth.baseline_at, null);
});

Deno.test("a zero baseline refuses the comparison", () => {
  const growth = mapGrowth(
    refused("zero_baseline", { baseline_at: "2026-10-13T12:00:00+00:00", baseline_followers: 0 }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "zero_baseline");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("a missing measurement refuses the comparison", () => {
  const growth = mapGrowth(
    refused("unavailable_metric", { observed_followers: null }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "unavailable_metric");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("the first observation refuses the comparison", () => {
  const growth = mapGrowth(
    refused("first_observation", { observed_at: null, observed_followers: null }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "first_observation");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("a source change refuses the comparison", () => {
  const growth = mapGrowth(
    refused("source_changed", {
      baseline_at: "2026-10-13T12:00:00+00:00",
      baseline_followers: 900,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "source_changed");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("a negative change is a valid change", () => {
  const growth = mapGrowth(
    comparable({
      observed_followers: 850,
      baseline_followers: 900,
      absolute: -50,
      percent: -5.555556,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, null);
  assertEquals(growth.absolute, -50);
  assertEquals(growth.percent, -5.555556);
});

Deno.test("the reported interval is the actual interval, not the requested one", () => {
  const growth = mapGrowth(
    comparable({
      baseline_at: "2026-10-12T00:00:00+00:00",
      interval_days: 8.5,
      interval_seconds: 734400,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.interval_days, 8.5);
  assertEquals(growth.reason, null);
});

Deno.test("a baseline exactly at the edge of the approved staleness is accepted", () => {
  // Seven days of period plus three days of staleness: the baseline sits
  // exactly on the edge and is still comparable.
  const growth = mapGrowth(
    comparable({
      baseline_at: "2026-10-10T12:00:00+00:00",
      interval_days: 10,
      interval_seconds: 864000,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, null);
  assertEquals(growth.absolute, 100);
});

Deno.test("a baseline older than the approved staleness is stale", () => {
  const growth = mapGrowth(
    comparable({
      baseline_at: "2026-10-10T11:59:59+00:00",
      interval_days: 10.0000115741,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "stale_baseline");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("a baseline newer than the cutoff is not a baseline", () => {
  const growth = mapGrowth(
    comparable({
      baseline_at: "2026-10-16T12:00:00+00:00",
      interval_days: 4,
    }),
    7,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "missing_baseline");
  assertEquals(growth.absolute, null);
});

Deno.test("without an approved policy no comparison is published", () => {
  const growth = mapGrowth(comparable(), 7, null);

  assertEquals(growth.reason, "baseline_policy_unset");
  assertEquals(growth.absolute, null);
  assertEquals(growth.percent, null);
});

Deno.test("a policy that is not a whole number of seconds is refused", () => {
  assertThrows(
    () => assertBaselinePolicy({ maxStalenessSeconds: 1.5 }),
    CompetitorReportContractError,
  );
  assertThrows(
    () => assertBaselinePolicy({ maxStalenessSeconds: -1 }),
    CompetitorReportContractError,
  );
  assertThrows(
    () => assertBaselinePolicy({ maxStalenessSeconds: Number.POSITIVE_INFINITY }),
    CompetitorReportContractError,
  );
  assertEquals(assertBaselinePolicy(null), null);
});

Deno.test("a non-finite number is refused", () => {
  assertThrows(
    () =>
      mapGrowth(
        comparable({ percent: Number.POSITIVE_INFINITY }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
  assertThrows(
    () =>
      mapGrowth(
        comparable({ interval_days: Number.NaN }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("an unsafe count is refused rather than rounded", () => {
  assertThrows(
    () =>
      mapGrowth(
        comparable({ absolute: 9_007_199_254_740_992 }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a refused comparison that carries numbers is refused", () => {
  assertThrows(
    () =>
      mapGrowth(
        refused("no_comparable_baseline", { absolute: 5, percent: 1 }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a comparable comparison without numbers is refused", () => {
  assertThrows(
    () =>
      mapGrowth(
        comparable({ absolute: null, percent: null }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("an unknown reason is refused", () => {
  assertThrows(
    () => mapGrowth(refused("made_up_reason"), 7, COMPETITOR_REPORT_BASELINE_POLICY),
    CompetitorReportContractError,
  );
});

Deno.test("a growth object of another period is refused", () => {
  assertThrows(
    () => mapGrowth(comparable({ period_days: 30 }), 7, COMPETITOR_REPORT_BASELINE_POLICY),
    CompetitorReportContractError,
  );
});

Deno.test("a baseline without an observation is refused", () => {
  assertThrows(
    () =>
      mapGrowth(
        comparable({ observed_at: null, observed_followers: null }),
        7,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a malformed growth payload is refused", () => {
  assertThrows(
    () => mapGrowth(null, 7, COMPETITOR_REPORT_BASELINE_POLICY),
    CompetitorReportContractError,
  );
  assertThrows(
    () => mapGrowth("nonsense", 7, COMPETITOR_REPORT_BASELINE_POLICY),
    CompetitorReportContractError,
  );
});

Deno.test("the thirty-day comparison uses its own window", () => {
  const growth = mapGrowth(
    comparable({
      period_days: 30,
      baseline_at: "2026-09-20T12:00:00+00:00",
      interval_days: 30,
      interval_seconds: 2592000,
      absolute: 200,
      percent: 25,
    }),
    30,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, null);
  assertEquals(growth.absolute, 200);
  assertEquals(growth.interval_days, 30);
});

Deno.test("a stale thirty-day baseline is stale as well", () => {
  const growth = mapGrowth(
    comparable({
      period_days: 30,
      baseline_at: "2026-09-17T11:59:59+00:00",
      interval_days: 33.0000115741,
    }),
    30,
    COMPETITOR_REPORT_BASELINE_POLICY,
  );

  assertEquals(growth.reason, "stale_baseline");
  assert(growth.absolute === null);
});
