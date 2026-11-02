/** Whole-window counts come from SQL; this suite proves coverage and payload honesty. */
import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CompetitorReportContractError, type RawCoverageRow } from "./contracts.ts";
import { assembleWeeklyInventory } from "./weeklyInventory.ts";

const ANCHOR = "2026-10-20T12:00:00+00:00";
const START = "2026-10-13T12:00:00+00:00";
function summary(count = 31) {
  return { observed_count: count, interval_start: START, interval_end: ANCHOR };
}
function coverage(overrides: Partial<RawCoverageRow> = {}): RawCoverageRow {
  return {
    captured_on: "2026-10-20", captured_at: ANCHOR, source: "official", job_generation: 3,
    capture_started_at: "2026-10-20T11:59:55+00:00", capture_ended_at: ANCHOR,
    oldest_returned_at: "2026-10-01T09:00:00+00:00", ordering_verified: true,
    cursor_present: false, exhausted: true, truncated: false, gap_reason: null, ...overrides,
  };
}

Deno.test("a committed whole-window count publishes a rate only with complete coverage", () => {
  const weekly = assembleWeeklyInventory({ summary: summary(), coverage: [coverage()] });
  assertEquals(weekly.observed_count, 31);
  assertEquals(weekly.posts_per_week, 31);
  assertEquals(weekly.coverage, "complete");
  assertEquals(weekly.reason, null);
});

for (const [name, flags, expectedCoverage, reason] of [
  ["unverified ordering", { ordering_verified: false }, "unknown", "ordering_unverified"],
  ["a bounded capture", { truncated: true }, "partial", "coverage_truncated"],
  ["a capture gap", { gap_reason: "provider_error" }, "partial", "capture_gap"],
  ["a nonexhausted feed", { exhausted: false, cursor_present: true }, "partial", "capture_not_exhausted"],
  ["an oldest item inside the week", { oldest_returned_at: "2026-10-19T00:00:00Z" }, "partial", "coverage_window_short"],
  ["an unknown oldest item", { oldest_returned_at: null }, "partial", "coverage_window_short"],
] as const) {
  Deno.test(`${name} preserves the observed count without inventing a complete weekly rate`, () => {
    const weekly = assembleWeeklyInventory({ summary: summary(), coverage: [coverage(flags)] });
    assertEquals(weekly.observed_count, 31);
    assertEquals(weekly.posts_per_week, null);
    assertEquals(weekly.coverage, expectedCoverage);
    assertEquals(weekly.reason, reason);
  });
}

Deno.test("no coverage still preserves the independently counted stored inventory", () => {
  const weekly = assembleWeeklyInventory({ summary: summary(2), coverage: [] });
  assertEquals(weekly.observed_count, 2);
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.reason, "coverage_missing");
  assertEquals(weekly.interval_start, "2026-10-13T12:00:00.000Z");
  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
});

Deno.test("an empty committed inventory has zero observed records without claiming zero publications", () => {
  const weekly = assembleWeeklyInventory({ summary: { observed_count: 0, interval_start: null, interval_end: null }, coverage: [] });
  assertEquals(weekly.observed_count, 0);
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.coverage, "unknown");
  assertEquals(weekly.reason, "coverage_missing");
});

Deno.test("a measured zero survives a real anchored interval", () => {
  const weekly = assembleWeeklyInventory({ summary: summary(0), coverage: [coverage()] });
  assertEquals(weekly.observed_count, 0);
  assertEquals(weekly.posts_per_week, 0);
});

Deno.test("the newest committed coverage and aggregate must describe the same window", () => {
  const weekly = assembleWeeklyInventory({ summary: summary(), coverage: [
    coverage({ captured_on: "2026-10-19", captured_at: "2026-10-19T12:00:00Z", capture_ended_at: "2026-10-19T12:00:00Z" }), coverage(),
  ] });
  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
  assertThrows(() => assembleWeeklyInventory({ summary: { ...summary(), interval_start: "2026-10-12T12:00:00Z", interval_end: "2026-10-19T12:00:00Z" }, coverage: [coverage()] }), CompetitorReportContractError);
});

Deno.test("missing and malformed aggregates fail as reads rather than becoming zero", () => {
  for (const malformed of [undefined, null, {}, { ...summary(), observed_count: null }, { ...summary(), observed_count: -1 },
    { ...summary(), observed_count: 1.5 }, { ...summary(), observed_count: Infinity }, { ...summary(), observed_count: Number.MAX_SAFE_INTEGER + 1 },
    { ...summary(), interval_start: null }, { ...summary(), interval_end: "yesterday" }, { ...summary(), interval_start: ANCHOR },
    { observed_count: 1, interval_start: null, interval_end: null }]) {
    assertThrows(() => assembleWeeklyInventory({ summary: malformed, coverage: [] }), CompetitorReportContractError);
  }
});

Deno.test("malformed coverage evidence is refused instead of silently reducing completeness", () => {
  for (const malformed of [{}, { ...coverage(), ordering_verified: "yes" }, { ...coverage(), captured_at: "invalid" }]) {
    assertThrows(() => assembleWeeklyInventory({ summary: summary(), coverage: [malformed] as unknown as RawCoverageRow[] }), CompetitorReportContractError);
  }
});
