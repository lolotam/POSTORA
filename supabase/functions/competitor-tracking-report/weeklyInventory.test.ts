/**
 * The weekly inventory of the competitor tracking report.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - The rate is published only when the committed coverage proves the
 *     seven-day window.
 *   - An unverified provider ordering is UNKNOWN: today that is every
 *     capture, so the rate is null and the reason says which piece of
 *     evidence is missing.
 *   - A bounded capture is PARTIAL: the observed count survives and the rate
 *     does not.
 *   - Repeated daily snapshots are not new posts.
 *   - The window is anchored to the committed inventory observation and never
 *     to the browser's clock.
 */

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  CompetitorReportContractError,
  type RawCoverageRow,
  type RawMedia,
} from "./contracts.ts";
import { assembleWeeklyInventory } from "./weeklyInventory.ts";

/** The anchor of the fixtures: 2026-10-20T12:00:00Z. */
const ANCHOR = "2026-10-20T12:00:00+00:00";

function coverage(overrides: Partial<RawCoverageRow> = {}): RawCoverageRow {
  return {
    captured_on: "2026-10-20",
    captured_at: ANCHOR,
    source: "official",
    job_generation: 3,
    capture_started_at: "2026-10-20T11:59:55+00:00",
    capture_ended_at: ANCHOR,
    oldest_returned_at: "2026-10-01T09:00:00+00:00",
    ordering_verified: true,
    cursor_present: false,
    exhausted: true,
    truncated: false,
    gap_reason: null,
    ...overrides,
  };
}

function media(
  igMediaId: string,
  publishedAt: string,
  overrides: Partial<RawMedia> = {},
): RawMedia {
  return {
    ig_media_id: igMediaId,
    published_at: publishedAt,
    captured_at: ANCHOR,
    media_product_type: "REELS",
    media_type: "VIDEO",
    thumbnail_url: null,
    permalink: null,
    caption: null,
    like_count: null,
    comments_count: null,
    view_count: 100,
    source: "official",
    metric_basis: "public_views",
    mature: true,
    baseline: [],
    baseline_incomplete: false,
    ...overrides,
  };
}

Deno.test("a complete coverage publishes the weekly rate", () => {
  const weekly = assembleWeeklyInventory({
    media: [
      media("m1", "2026-10-19T09:00:00+00:00"),
      media("m2", "2026-10-17T09:00:00+00:00"),
      media("m3", "2026-10-13T12:00:00+00:00"),
    ],
    coverage: [coverage()],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "complete");
  assertEquals(weekly.reason, null);
  assertEquals(weekly.observed_count, 3);
  assertEquals(weekly.posts_per_week, 3);
  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
  assertEquals(weekly.interval_start, "2026-10-13T12:00:00.000Z");
});

Deno.test("a post outside the window is not counted", () => {
  const weekly = assembleWeeklyInventory({
    media: [
      media("m1", "2026-10-19T09:00:00+00:00"),
      media("old", "2026-10-13T11:59:59+00:00"),
    ],
    coverage: [coverage()],
    inventoryIncluded: true,
  });

  assertEquals(weekly.observed_count, 1);
  assertEquals(weekly.posts_per_week, 1);
});

Deno.test("repeated daily snapshots are not new posts", () => {
  const weekly = assembleWeeklyInventory({
    media: [
      media("m1", "2026-10-19T09:00:00+00:00", { captured_at: "2026-10-19T12:00:00+00:00" }),
      media("m1", "2026-10-19T09:00:00+00:00", { captured_at: "2026-10-20T12:00:00+00:00" }),
    ],
    coverage: [coverage()],
    inventoryIncluded: true,
  });

  assertEquals(weekly.observed_count, 1);
  assertEquals(weekly.posts_per_week, 1);
});

Deno.test("an unverified provider ordering is unknown", () => {
  const weekly = assembleWeeklyInventory({
    media: [media("m1", "2026-10-19T09:00:00+00:00")],
    coverage: [coverage({ ordering_verified: false })],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "unknown");
  assertEquals(weekly.reason, "ordering_unverified");
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.observed_count, 1);
});

Deno.test("a bounded capture is partial and publishes no rate", () => {
  const weekly = assembleWeeklyInventory({
    media: [
      media("m1", "2026-10-19T09:00:00+00:00"),
      media("m2", "2026-10-18T09:00:00+00:00"),
    ],
    coverage: [coverage({ truncated: true, gap_reason: "media_cap_reached", exhausted: false })],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "partial");
  assertEquals(weekly.reason, "coverage_truncated");
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.observed_count, 2);
});

Deno.test("a capture with a gap is partial", () => {
  const weekly = assembleWeeklyInventory({
    media: [media("m1", "2026-10-19T09:00:00+00:00")],
    coverage: [coverage({ gap_reason: "capture_gap", exhausted: false })],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "partial");
  assertEquals(weekly.reason, "capture_gap");
  assertEquals(weekly.posts_per_week, null);
});

Deno.test("a capture that did not exhaust the feed is partial", () => {
  const weekly = assembleWeeklyInventory({
    media: [media("m1", "2026-10-19T09:00:00+00:00")],
    coverage: [coverage({ exhausted: false })],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "partial");
  assertEquals(weekly.reason, "capture_not_exhausted");
  assertEquals(weekly.posts_per_week, null);
});

Deno.test("the oldest returned timestamp must reach the start of the window", () => {
  const weekly = assembleWeeklyInventory({
    media: [media("m1", "2026-10-19T09:00:00+00:00")],
    coverage: [coverage({ oldest_returned_at: "2026-10-18T09:00:00+00:00" })],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "partial");
  assertEquals(weekly.reason, "coverage_window_short");
  assertEquals(weekly.posts_per_week, null);
});

Deno.test("no coverage at all is unknown", () => {
  const weekly = assembleWeeklyInventory({
    media: [media("m1", "2026-10-19T09:00:00+00:00")],
    coverage: [],
    inventoryIncluded: true,
  });

  assertEquals(weekly.coverage, "unknown");
  assertEquals(weekly.reason, "coverage_missing");
  assertEquals(weekly.posts_per_week, null);
  // Without a coverage ledger the window falls back to the newest capture
  // the media themselves carry, so the UI still shows a real interval.
  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
  assertEquals(weekly.interval_start, "2026-10-13T12:00:00.000Z");
});

Deno.test("an entry with neither coverage nor media has no observed post", () => {
  const weekly = assembleWeeklyInventory({
    media: [],
    coverage: [],
    inventoryIncluded: true,
  });

  assertEquals(weekly.observed_count, 0);
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.coverage, "unknown");
  assertEquals(weekly.reason, "coverage_missing");
});

Deno.test("the window is anchored to the committed coverage, not to the clock", () => {
  const weekly = assembleWeeklyInventory({
    media: [],
    coverage: [
      coverage({
        captured_on: "2026-10-19",
        captured_at: "2026-10-19T12:00:00+00:00",
        capture_ended_at: "2026-10-19T12:00:00+00:00",
      }),
      coverage(),
    ],
    inventoryIncluded: true,
  });

  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
  assertEquals(weekly.interval_start, "2026-10-13T12:00:00.000Z");
});

Deno.test("a list response publishes no rate because it carries no inventory", () => {
  const weekly = assembleWeeklyInventory({
    media: [],
    coverage: [coverage()],
    inventoryIncluded: false,
  });

  assertEquals(weekly.observed_count, 0);
  assertEquals(weekly.posts_per_week, null);
  assertEquals(weekly.reason, "media_not_included");
  // The interval is still the committed one: the UI can show the window.
  assertEquals(weekly.interval_end, "2026-10-20T12:00:00.000Z");
});

Deno.test("a malformed coverage row is refused", () => {
  assertThrows(
    () =>
      assembleWeeklyInventory({
        media: [],
        coverage: [{ captured_on: "not-a-date" } as unknown as RawCoverageRow],
        inventoryIncluded: true,
      }),
    CompetitorReportContractError,
  );
});

Deno.test("a coverage flag that is not a boolean is refused", () => {
  assertThrows(
    () =>
      assembleWeeklyInventory({
        media: [],
        coverage: [coverage({ ordering_verified: "yes" as unknown as boolean })],
        inventoryIncluded: true,
      }),
    CompetitorReportContractError,
  );
});

Deno.test("a malformed media row is refused", () => {
  assertThrows(
    () =>
      assembleWeeklyInventory({
        media: [{ ig_media_id: "m1" } as unknown as RawMedia],
        coverage: [],
        inventoryIncluded: true,
      }),
    CompetitorReportContractError,
  );
});
