import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type OutlierFormat,
  type OutlierInput,
  type OutlierOptions,
  type OutlierResult,
  computeOutlierScores,
} from "./outlierScore.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const NOW_MS = NOW.getTime();
const HOUR_MS = 3_600_000;

function hoursAgo(hours: number): string {
  return new Date(NOW_MS - hours * HOUR_MS).toISOString();
}

function item(
  id: string,
  format: OutlierFormat,
  ageHours: number,
  value: number | null,
): OutlierInput {
  return { id, format, publishedAt: hoursAgo(ageHours), value };
}

/** `count` mature items, the newest `newestAgeHours` old, each one hour older. */
function history(
  count: number,
  value: number | null,
  format: OutlierFormat = "non_reel",
  newestAgeHours = 200,
  prefix = "h",
): OutlierInput[] {
  return Array.from({ length: count }, (_, index) =>
    item(`${prefix}${index}`, format, newestAgeHours + index, value)
  );
}

/** `count` mature items whose value grows by one per item. */
function ramp(
  count: number,
  firstValue = 1,
  format: OutlierFormat = "non_reel",
  newestAgeHours = 200,
  prefix = "h",
): OutlierInput[] {
  return Array.from({ length: count }, (_, index) =>
    item(`${prefix}${index}`, format, newestAgeHours + index, firstValue + index)
  );
}

function byId(results: readonly OutlierResult[]): Record<string, OutlierResult> {
  const map: Record<string, OutlierResult> = {};
  for (const result of results) map[result.id] = result;
  return map;
}

Deno.test("returns one result per input, in input order, carrying the id", () => {
  const items = [
    ...history(6, 10),
    item("target", "non_reel", 72, 20),
    item("second", "non_reel", 72, 30),
  ];
  const results = computeOutlierScores(items, NOW);

  assertEquals(results.length, items.length);
  assertEquals(results.map((result) => result.id), items.map((entry) => entry.id));
});

Deno.test("the label thresholds are inclusive at 3, 1.5 and 0.5", () => {
  const base = history(12, 10);
  const scored = (value: number) =>
    computeOutlierScores([...base, item("target", "non_reel", 72, value)], NOW)[12];

  assertEquals(scored(30).label, "outlier");
  assertEquals(scored(30).score, 3);
  assertEquals(scored(29.999999).label, "above");

  assertEquals(scored(15).label, "above");
  assertEquals(scored(15).score, 1.5);
  assertEquals(scored(14.999999).label, "normal");

  assertEquals(scored(10).label, "normal");
  assertEquals(scored(10).score, 1);

  assertEquals(scored(5).label, "below");
  assertEquals(scored(5).score, 0.5);
  assertEquals(scored(5.000001).label, "normal");
});

Deno.test("reels and non-reels never share a baseline", () => {
  const items = [
    ...history(6, 10, "non_reel", 200, "n"),
    ...history(6, 1000, "reel", 200, "r"),
    item("reelTarget", "reel", 72, 20),
    item("postTarget", "non_reel", 72, 20),
  ];
  const results = byId(computeOutlierScores(items, NOW));

  assertEquals(results.reelTarget.baselineSize, 6);
  assertEquals(results.reelTarget.baselineMedian, 1000);
  assertEquals(results.reelTarget.score, 0.02);

  assertEquals(results.postTarget.baselineSize, 6);
  assertEquals(results.postTarget.baselineMedian, 10);
  assertEquals(results.postTarget.score, 2);
});

Deno.test("a format without history cannot borrow another format's baseline", () => {
  const items = [
    ...history(6, 10, "non_reel", 200, "n"),
    item("reelTarget", "reel", 72, 20),
  ];
  const results = computeOutlierScores(items, NOW);

  assertEquals(results[6].label, "small_baseline");
  assertEquals(results[6].baselineSize, 0);
  assertEquals(results[6].baselineMedian, null);
  assertEquals(results[6].score, null);
});

Deno.test("the scored item is never part of its own baseline", () => {
  const items = [...ramp(12, 1), item("target", "non_reel", 72, 100)];
  const result = computeOutlierScores(items, NOW)[12];

  // With the item in the baseline the median would be 7 instead of 6.5.
  assertEquals(result.baselineSize, 12);
  assertEquals(result.baselineMedian, 6.5);
  assertEquals(result.score, 100 / 6.5);
});

Deno.test("the result does not depend on the order of the input", () => {
  const items = [...ramp(12, 1), item("target", "non_reel", 72, 20)];
  const forward = computeOutlierScores(items, NOW);
  const reversed = computeOutlierScores([...items].reverse(), NOW);
  const rotated = computeOutlierScores(
    [...items.slice(3), ...items.slice(0, 3)],
    NOW,
  );

  assertEquals(byId(reversed), byId(forward));
  assertEquals(byId(rotated), byId(forward));
});

Deno.test("unusable values are excluded and do not consume the baseline budget", () => {
  const items = [
    ...ramp(12, 1),
    ...history(5, null, "non_reel", 150, "n"),
    item("target", "non_reel", 72, 13),
  ];
  const result = computeOutlierScores(items, NOW).at(-1)!;

  assertEquals(result.baselineSize, 12);
  assertEquals(result.baselineMedian, 6.5);
  assertEquals(result.score, 2);
  assertEquals(result.label, "above");
});

Deno.test("a zero median produces no_data instead of an infinite score", () => {
  const measured = computeOutlierScores(
    [...history(12, 0), item("target", "non_reel", 72, 10)],
    NOW,
  ).at(-1)!;
  assertEquals(measured.label, "no_data");
  assertEquals(measured.score, null);
  assertEquals(measured.baselineMedian, 0);
  assertEquals(measured.baselineSize, 12);

  const zero = computeOutlierScores(
    [...history(12, 0), item("target", "non_reel", 72, 0)],
    NOW,
  ).at(-1)!;
  assertEquals(zero.label, "no_data");
  assertEquals(zero.score, null);
});

Deno.test("a zero value is a measurement, not missing data", () => {
  const result = computeOutlierScores(
    [...history(12, 10), item("target", "non_reel", 72, 0)],
    NOW,
  ).at(-1)!;

  assertEquals(result.label, "below");
  assertEquals(result.score, 0);
  assertEquals(result.baselineMedian, 10);
});

Deno.test("every score is finite, even when the quotient overflows", () => {
  const overflowing = computeOutlierScores(
    [...history(6, 1e-300), item("target", "non_reel", 72, 1e300)],
    NOW,
  ).at(-1)!;

  assertEquals(Number.isFinite(overflowing.score), true);
  assertEquals(overflowing.label, "outlier");
  assertEquals(overflowing.baselineMedian, 1e-300);

  for (const result of computeOutlierScores(
    [...ramp(12, 1), item("target", "non_reel", 72, 13)],
    NOW,
  )) {
    if (result.score !== null) {
      assert(Number.isFinite(result.score), `score for ${result.id} must be finite`);
    }
  }
});

Deno.test("an item exactly 48 hours old is mature and a younger one is too early", () => {
  const base = history(12, 10);

  const mature = computeOutlierScores(
    [...base, item("target", "non_reel", 48, 30)],
    NOW,
  ).at(-1)!;
  assertEquals(mature.label, "outlier");
  assertEquals(mature.score, 3);

  const young = computeOutlierScores(
    [...base, item("target", "non_reel", 47.999, 30)],
    NOW,
  ).at(-1)!;
  assertEquals(young.label, "too_early");
  assertEquals(young.score, null);
  assertEquals(young.baselineSize, 0);
  assertEquals(young.baselineMedian, null);
});

Deno.test("future items are too early and never become baseline history", () => {
  const items = [
    ...history(6, 10, "non_reel", 200, "m"),
    ...history(12, 999, "non_reel", -12, "f"),
    item("target", "non_reel", 72, 20),
  ];
  const results = computeOutlierScores(items, NOW);
  const target = results.at(-1)!;

  assertEquals(target.baselineSize, 6);
  assertEquals(target.baselineMedian, 10);
  assertEquals(target.score, 2);

  for (const future of results.slice(6, 18)) {
    assertEquals(future.label, "too_early");
    assertEquals(future.score, null);
    assertEquals(future.baselineSize, 0);
  }
});

Deno.test("items published at the same instant never baseline each other", () => {
  const items = [
    ...ramp(6, 1),
    item("twin", "non_reel", 72, 0),
    item("target", "non_reel", 72, 7),
  ];
  const results = computeOutlierScores(items, NOW);
  const twin = results[6];
  const target = results[7];

  assertEquals(target.baselineSize, 6);
  assertEquals(target.baselineMedian, 3.5);
  assertEquals(target.score, 2);
  assertEquals(target.label, "above");

  assertEquals(twin.baselineSize, 6);
  assertEquals(twin.baselineMedian, 3.5);
  assertEquals(twin.score, 0);
  assertEquals(twin.label, "below");
});

Deno.test("the baseline tie is broken by the item id", () => {
  const items = [
    ...ramp(11, 1, "non_reel", 110, "n"),
    item("t-a", "non_reel", 300, 0),
    item("t-b", "non_reel", 300, 100),
    item("target", "non_reel", 72, 11),
  ];
  const result = computeOutlierScores(items, NOW).at(-1)!;

  // "t-a" and "t-b" share an instant and the budget runs out between them.
  // The smaller id wins, so the median is 5.5 rather than 6.5.
  assertEquals(result.baselineSize, 12);
  assertEquals(result.baselineMedian, 5.5);

  const reversed = byId(computeOutlierScores([...items].reverse(), NOW));
  assertEquals(reversed.target, result);
});

Deno.test("the baseline is the most recent history, not the oldest", () => {
  const items = [
    ...history(12, 100, "non_reel", 200, "o"),
    ...history(12, 10, "non_reel", 100, "n"),
    item("target", "non_reel", 72, 30),
  ];
  const result = computeOutlierScores(items, NOW).at(-1)!;

  assertEquals(result.baselineSize, 12);
  assertEquals(result.baselineMedian, 10);
  assertEquals(result.score, 3);
  assertEquals(result.label, "outlier");
});

Deno.test("the input array and its items are not mutated", () => {
  const items = [...ramp(12, 1), item("target", "non_reel", 72, 20)].map((entry) =>
    Object.freeze({ ...entry })
  );
  const frozen = Object.freeze(items) as unknown as OutlierInput[];
  const before = JSON.stringify(frozen);

  const results = computeOutlierScores(frozen, NOW);

  assertEquals(results.length, items.length);
  assertEquals(JSON.stringify(frozen), before);
});

Deno.test("an even baseline takes the midpoint of the two middle values", () => {
  const result = computeOutlierScores(
    [...ramp(6, 1), item("target", "non_reel", 72, 7)],
    NOW,
  ).at(-1)!;

  assertEquals(result.baselineSize, 6);
  assertEquals(result.baselineMedian, 3.5);
  assertEquals(result.score, 2);
  assertEquals(result.label, "above");
});

Deno.test("an odd baseline takes the middle value", () => {
  const result = computeOutlierScores(
    [...ramp(7, 1), item("target", "non_reel", 72, 8)],
    NOW,
  ).at(-1)!;

  assertEquals(result.baselineSize, 7);
  assertEquals(result.baselineMedian, 4);
  assertEquals(result.score, 2);
});

Deno.test("fewer than six mature prior items yields small_baseline", () => {
  const result = computeOutlierScores(
    [...history(5, 10), item("target", "non_reel", 72, 20)],
    NOW,
  ).at(-1)!;

  assertEquals(result.label, "small_baseline");
  assertEquals(result.score, null);
  assertEquals(result.baselineSize, 5);
  assertEquals(result.baselineMedian, 10);

  const enough = computeOutlierScores(
    [...history(6, 10), item("target", "non_reel", 72, 20)],
    NOW,
  ).at(-1)!;
  assertEquals(enough.label, "above");
  assertEquals(enough.baselineSize, 6);
});

Deno.test("custom options change the baseline size, the minimum and the maturity window", () => {
  const items = [
    ...history(3, 10, "non_reel", 10),
    item("target", "non_reel", 2, 30),
  ];

  const strict = computeOutlierScores(items, NOW).at(-1)!;
  assertEquals(strict.label, "too_early");

  const relaxed = computeOutlierScores(items, NOW, {
    baselineSize: 3,
    minBaseline: 2,
    minAgeHours: 1,
  }).at(-1)!;
  assertEquals(relaxed.label, "outlier");
  assertEquals(relaxed.score, 3);
  assertEquals(relaxed.baselineSize, 3);
  assertEquals(relaxed.baselineMedian, 10);
});

Deno.test("invalid options are rejected", () => {
  const items = [...history(12, 10), item("target", "non_reel", 72, 20)];
  const invalid: unknown[] = [
    { baselineSize: 0 },
    { baselineSize: -1 },
    { baselineSize: 1.5 },
    { baselineSize: Number.NaN },
    { baselineSize: Number.POSITIVE_INFINITY },
    { baselineSize: "12" },
    { minBaseline: 0 },
    { minBaseline: -3 },
    { minBaseline: 13 },
    { baselineSize: 4 },
    { baselineSize: 6, minBaseline: 7 },
    { minAgeHours: -1 },
    { minAgeHours: Number.NaN },
    { minAgeHours: Number.POSITIVE_INFINITY },
    { minAgeHours: "48" },
    { baselineSize: 12, unknown: 1 },
  ];

  for (const opts of invalid) {
    assertThrows(
      () => computeOutlierScores(items, NOW, opts as OutlierOptions),
      RangeError,
      undefined,
      `expected ${JSON.stringify(opts)} to be rejected`,
    );
  }
});

Deno.test("a malformed now is rejected", () => {
  const items = [...history(12, 10)];

  assertThrows(
    () => computeOutlierScores(items, new Date("not a date")),
    RangeError,
  );
  assertThrows(
    () => computeOutlierScores(items, "2026-10-26" as unknown as Date),
    TypeError,
  );
  assertThrows(
    () => computeOutlierScores(items, undefined as unknown as Date),
    TypeError,
  );
});

Deno.test("an unusable value or publication instant is reported as no_data", () => {
  const broken: OutlierInput[] = [
    { id: "a", format: "non_reel", publishedAt: "not a date", value: 10 },
    { id: "b", format: "non_reel", publishedAt: "2026-02-30", value: 10 },
    { id: "c", format: "non_reel", publishedAt: hoursAgo(100), value: null },
    { id: "d", format: "non_reel", publishedAt: hoursAgo(100), value: Number.NaN },
    {
      id: "e",
      format: "non_reel",
      publishedAt: hoursAgo(100),
      value: Number.POSITIVE_INFINITY,
    },
    { id: "f", format: "non_reel", publishedAt: hoursAgo(100), value: -5 },
  ];

  for (const row of broken) {
    const result = computeOutlierScores([row], NOW)[0];
    assertEquals(result.label, "no_data", `row ${row.id} must be no_data`);
    assertEquals(result.score, null);
    assertEquals(result.baselineSize, 0);
    assertEquals(result.baselineMedian, null);
  }
});

Deno.test("an impossible calendar date is rejected instead of rolling over", () => {
  const result = computeOutlierScores(
    [{ id: "r", format: "non_reel", publishedAt: "2026-02-30T00:00:00Z", value: 10 }],
    NOW,
  )[0];

  assertEquals(result.label, "no_data");
});

Deno.test("no_data wins over too_early", () => {
  const missingValue = computeOutlierScores(
    [{ id: "x", format: "non_reel", publishedAt: hoursAgo(1), value: null }],
    NOW,
  )[0];
  assertEquals(missingValue.label, "no_data");

  const brokenDate = computeOutlierScores(
    [{ id: "y", format: "non_reel", publishedAt: "not a date", value: 10 }],
    NOW,
  )[0];
  assertEquals(brokenDate.label, "no_data");

  const young = computeOutlierScores(
    [{ id: "z", format: "non_reel", publishedAt: hoursAgo(1), value: 10 }],
    NOW,
  )[0];
  assertEquals(young.label, "too_early");
});

Deno.test("a timestamp without a zone designator is read as UTC", () => {
  const items = [
    ...history(6, 10, "non_reel", 200, "h"),
    { id: "b", format: "non_reel" as const, publishedAt: "2026-10-24T09:00:00Z", value: 0 },
    { id: "a", format: "non_reel" as const, publishedAt: "2026-10-24T12:00:00", value: 7 },
  ];
  const results = computeOutlierScores(items, NOW);
  const a = results.at(-1)!;

  // "a" is exactly 48 hours old, so it is mature, and "b" is three hours
  // older, so "b" belongs to its baseline.
  assertEquals(a.label, "normal");
  assertEquals(a.baselineSize, 7);
  assertEquals(a.baselineMedian, 10);
  assertEquals(a.score, 0.7);
});

Deno.test("a provider offset of +0000 is the same UTC instant as Z", () => {
  const base = history(6, 10);
  const at = (publishedAt: string) =>
    computeOutlierScores(
      [...base, { id: "target", format: "non_reel", publishedAt, value: 20 }],
      NOW,
    ).at(-1)!;

  const zoned = at("2026-10-24T12:00:00+0000");
  const zulu = at("2026-10-24T12:00:00Z");

  assertEquals(zoned, zulu);
  assertEquals(zoned.label, "above");
  assertEquals(zoned.score, 2);
  assertEquals(zoned.baselineSize, 6);
  assertEquals(zoned.baselineMedian, 10);
});

Deno.test("non-ISO unzoned and ambiguous dates are no_data and stay out of the baseline", () => {
  // These are forms Date.parse accepts in a locale- or host-timezone-dependent
  // way. They must not become a mature instant on one runtime and too_early
  // on another, and they must not change a neighbor's 48-hour baseline.
  const rejected = [
    { id: "prose", publishedAt: "October 24, 2026 12:00:00" },
    { id: "mdy", publishedAt: "10/24/2026 12:00:00" },
    { id: "dmy", publishedAt: "24/10/2026 12:00:00" },
  ];
  const items: OutlierInput[] = [
    ...history(6, 10),
    ...rejected.map((row) => ({
      id: row.id,
      format: "non_reel" as const,
      publishedAt: row.publishedAt,
      value: 999,
    })),
    item("target", "non_reel", 72, 20),
  ];
  const results = byId(computeOutlierScores(items, NOW));

  for (const row of rejected) {
    assertEquals(results[row.id].label, "no_data", `${row.publishedAt} must be no_data`);
    assertEquals(results[row.id].score, null);
    assertEquals(results[row.id].baselineSize, 0);
    assertEquals(results[row.id].baselineMedian, null);
  }

  assertEquals(results.target.label, "above");
  assertEquals(results.target.score, 2);
  assertEquals(results.target.baselineSize, 6);
  assertEquals(results.target.baselineMedian, 10);
});
