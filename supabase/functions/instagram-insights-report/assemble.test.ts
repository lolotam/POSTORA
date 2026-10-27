/**
 * Tests for the owner Instagram insights report contract and assembler.
 *
 * These are the tests the plan asks for (Task 5 acceptance): the canonical
 * scorer is really called, the baseline is independent of the display
 * period and of the display page, mixed accounts are refused, unknown
 * classifications are not guessed into a cohort, reach and interactions
 * never share a median, null stays null, and the serialised report never
 * carries a non-finite number or a credential.
 *
 * The fixtures below are synthetic rows for the OWNER tables. They are not
 * provider captures and are not evidence that the provider returns them.
 */

import {
  assert,
  assertEquals,
  assertExists,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { computeOutlierScores } from "../_shared/outlierScore.ts";
import {
  OWNER_REPORT_LAG_NOTE,
  OWNER_REPORT_MAX_LIMIT,
  OwnerReportContractError,
  parseOwnerReportRequest,
  type AccountDailyRow,
  type MediaSnapshotRow,
  type OwnerReportAssemblyInput,
  type OwnerReportCompletenessInput,
  type OwnerReportFreshnessInput,
  type OwnerReportRequest,
  type ProfileObservationRow,
} from "./contracts.ts";
import { assembleOwnerReport } from "./assemble.ts";

const NOW = new Date("2026-10-26T12:00:00.000Z");
const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;

const OWNER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "22222222-2222-4222-8222-222222222222";
const OTHER_ACCOUNT_ID = "33333333-3333-4333-8333-333333333333";

/** An instant `days` (and `hours`) before the report instant. */
function at(days: number, hours = 0): string {
  return new Date(NOW.getTime() - days * DAY_MS - hours * HOUR_MS).toISOString();
}

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

type MediaSpec = {
  mediaId: string;
  publishedAt: string;
  id?: string;
  capturedAt?: string;
  capturedOn?: string;
  productType?: string | null;
  mediaType?: string | null;
  status?: "pending" | "ok" | "unavailable" | "error";
  views?: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  saved?: number | null;
  shares?: number | null;
  totalInteractions?: number | null;
  ownerId?: string | null;
  socialAccountId?: string | null;
};

function mediaRow(spec: MediaSpec): MediaSnapshotRow {
  const capturedAt = spec.capturedAt ?? at(0, 6);
  return {
    id: spec.id ?? `snap-${spec.mediaId}`,
    ownerId: spec.ownerId === undefined ? OWNER_ID : spec.ownerId,
    socialAccountId: spec.socialAccountId === undefined ? ACCOUNT_ID : spec.socialAccountId,
    mediaId: spec.mediaId,
    publishedAt: spec.publishedAt,
    capturedAt,
    capturedOn: spec.capturedOn ?? dateOf(capturedAt),
    captureTimezone: "Asia/Kuwait",
    mediaProductType: spec.productType === undefined ? "FEED" : spec.productType,
    mediaType: spec.mediaType === undefined ? "IMAGE" : spec.mediaType,
    status: spec.status ?? "ok",
    views: spec.views ?? null,
    reach: spec.reach ?? null,
    likes: spec.likes ?? null,
    comments: spec.comments ?? null,
    saved: spec.saved ?? null,
    shares: spec.shares ?? null,
    totalInteractions: spec.totalInteractions ?? null,
  };
}

/** Eight older non-reel posts. The reach baseline. */
const REACH_HISTORY: MediaSnapshotRow[] = Array.from({ length: 8 }, (_, index) =>
  mediaRow({
    mediaId: `h${index}`,
    publishedAt: at(40 + index),
    reach: 100,
    likes: 10,
    comments: 2,
    saved: 1,
    shares: 3,
  })
);

/** Six older reels. The views baseline. */
const REEL_HISTORY: MediaSnapshotRow[] = Array.from({ length: 6 }, (_, index) =>
  mediaRow({
    mediaId: `rh${index}`,
    publishedAt: at(40 + index),
    productType: "REELS",
    mediaType: "VIDEO",
    views: 200,
    reach: 300,
  })
);

/** Six older posts without reach. The interactions baseline. */
const INTERACTION_HISTORY: MediaSnapshotRow[] = Array.from({ length: 6 }, (_, index) =>
  mediaRow({
    mediaId: `ih${index}`,
    publishedAt: at(50 + index),
    reach: null,
    totalInteractions: 50,
  })
);

/** The media inside the display window. */
const DISPLAY_MEDIA: MediaSnapshotRow[] = [
  mediaRow({
    mediaId: "d1",
    publishedAt: at(2),
    reach: 500,
    likes: 50,
    comments: 5,
    saved: 5,
    shares: 5,
  }),
  mediaRow({
    mediaId: "d2",
    publishedAt: at(3),
    productType: "REELS",
    mediaType: "VIDEO",
    views: 1000,
    reach: 400,
    likes: 40,
    comments: 4,
    saved: 4,
    shares: 2,
  }),
  mediaRow({ mediaId: "d3", publishedAt: at(4), reach: null, totalInteractions: 60, likes: 6 }),
  mediaRow({ mediaId: "d4", publishedAt: at(5, 1) }),
  mediaRow({
    mediaId: "d5",
    publishedAt: at(0, 1),
    reach: 100,
    likes: 10,
    comments: 1,
    saved: 1,
    shares: 1,
  }),
  mediaRow({
    mediaId: "d6",
    publishedAt: new Date(NOW.getTime() + 2 * DAY_MS).toISOString(),
    reach: 100,
  }),
  mediaRow({
    mediaId: "d7",
    publishedAt: at(6),
    productType: null,
    mediaType: "VIDEO",
    reach: 200,
  }),
  mediaRow({ mediaId: "d8", publishedAt: at(6), productType: "STORY", reach: 300 }),
  mediaRow({ mediaId: "d9", publishedAt: at(6), productType: "FEED", mediaType: "VIDEO", reach: 120 }),
  mediaRow({
    mediaId: "d10",
    publishedAt: at(3, 12),
    productType: "REELS",
    mediaType: "VIDEO",
    views: null,
    reach: 900,
    likes: 90,
    comments: 9,
    saved: 9,
    shares: 9,
  }),
  mediaRow({ mediaId: "d11", publishedAt: at(5, 2), reach: 0, likes: 5 }),
  mediaRow({
    mediaId: "d12",
    publishedAt: at(5, 3),
    reach: 100,
    likes: 10,
    comments: null,
    saved: 5,
    shares: 5,
  }),
];

/** The period-independent inventory the baseline is computed from. */
const ALL_MEDIA: MediaSnapshotRow[] = [
  ...REACH_HISTORY,
  ...REEL_HISTORY,
  ...INTERACTION_HISTORY,
  ...DISPLAY_MEDIA,
];

function dailyRow(
  id: string,
  metricDate: string,
  capturedAt: string,
  reach: number | null,
): AccountDailyRow {
  return {
    id,
    ownerId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    metricDate,
    providerDate: metricDate,
    periodStart: `${metricDate}T00:00:00.000Z`,
    periodEnd: `${metricDate}T23:59:59.999Z`,
    providerTimezone: "Asia/Kuwait",
    status: "ok",
    capturedAt,
    reach,
    views: reach === null ? null : 40,
    accountsEngaged: 12,
    totalInteractions: 24,
    likes: 12,
    comments: 6,
    saves: 3,
    shares: 3,
    follows: 1,
    unfollows: 0,
  };
}

const DAILY_ROWS: AccountDailyRow[] = [
  dailyRow("dly-20", "2026-10-20", "2026-10-22T03:00:00.000Z", 100),
  dailyRow("dly-21", "2026-10-21", "2026-10-22T03:00:00.000Z", 110),
  dailyRow("dly-22", "2026-10-22", "2026-10-23T03:00:00.000Z", 120),
  dailyRow("dly-23", "2026-10-23", "2026-10-24T03:00:00.000Z", 130),
  dailyRow("dly-24", "2026-10-24", "2026-10-25T03:00:00.000Z", 140),
  // A newer capture of an already captured day: the newer one wins.
  dailyRow("dly-24b", "2026-10-24", "2026-10-26T09:00:00.000Z", 145),
  dailyRow("dly-25", "2026-10-25", "2026-10-26T03:00:00.000Z", 150),
  dailyRow("dly-26", "2026-10-26", "2026-10-26T11:00:00.000Z", 160),
  // Outside the seven day window.
  dailyRow("dly-10", "2026-10-10", "2026-10-12T03:00:00.000Z", 90),
];

const PROFILE_ROWS: ProfileObservationRow[] = [
  {
    id: "obs-1",
    ownerId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    observedAt: "2026-10-24T03:10:00.000Z",
    observedOn: "2026-10-24",
    captureTimezone: "Asia/Kuwait",
    status: "ok",
    followersCount: 1200,
    mediaCount: 42,
  },
  {
    id: "obs-2",
    ownerId: OWNER_ID,
    socialAccountId: ACCOUNT_ID,
    observedAt: "2026-10-26T03:10:00.000Z",
    observedOn: "2026-10-26",
    captureTimezone: "Asia/Kuwait",
    status: "ok",
    followersCount: 1250,
    mediaCount: 43,
  },
];

const FRESHNESS: OwnerReportFreshnessInput = {
  status: "error",
  lastAttemptAt: "2026-10-26T11:00:00.000Z",
  lastSuccessAt: "2026-10-24T03:00:00.000Z",
  lastPartialAt: "2026-10-25T03:00:00.000Z",
  partial: false,
  truncated: false,
  retryAt: "2026-10-27T03:00:00.000Z",
  reason: "provider_error",
};

const COMPLETENESS: OwnerReportCompletenessInput = {
  baselineHistoryComplete: true,
  inventoryTruncated: false,
  coverage: "complete",
  oldestMediaPublishedAt: at(55),
  newestMediaPublishedAt: at(0, 1),
};

function buildInput(
  overrides: Partial<OwnerReportAssemblyInput> = {},
): OwnerReportAssemblyInput {
  return {
    scope: { ownerId: OWNER_ID, socialAccountId: ACCOUNT_ID, platform: "instagram" },
    now: NOW,
    request: { periodDays: 7, limit: 20, cursor: null },
    mediaSnapshots: DISPLAY_MEDIA,
    baselineHistory: ALL_MEDIA,
    accountDaily: DAILY_ROWS,
    profileObservations: PROFILE_ROWS,
    freshness: FRESHNESS,
    completeness: COMPLETENESS,
    ...overrides,
  };
}

Deno.test("the assembler itself refuses an unsupported display period", () => {
  const input = buildInput();
  const error = assertThrows(() => assembleOwnerReport({
    ...input,
    request: { ...input.request, periodDays: 8 } as unknown as OwnerReportRequest,
  }), OwnerReportContractError);
  assertEquals(error.code, "INVALID_PERIOD");
});

Deno.test("the assembler itself enforces the maximum page size", () => {
  const input = buildInput();
  const error = assertThrows(() => assembleOwnerReport({
    ...input, request: { ...input.request, limit: 100000 },
  }), OwnerReportContractError);
  assertEquals(error.code, "INVALID_LIMIT");
});

Deno.test("the assembler refuses a missing or null required page size", () => {
  for (const limit of [undefined, null]) {
    const input = buildInput();
    const error = assertThrows(() => assembleOwnerReport({
      ...input, request: { ...input.request, limit } as unknown as OwnerReportRequest,
    }), OwnerReportContractError);
    assertEquals(error.code, "INVALID_LIMIT");
  }
});

Deno.test("the assembler itself validates cursor structure", () => {
  const input = buildInput();
  const error = assertThrows(() => assembleOwnerReport({
    ...input, request: { ...input.request, cursor: {} } as unknown as OwnerReportRequest,
  }), OwnerReportContractError);
  assertEquals(error.code, "INVALID_CURSOR");
});

for (const status of ["error", "pending", "unavailable"] as const) {
  Deno.test(`a later ${status} daily row respects completed capture semantics`, () => {
    const good = dailyRow("good-day", "2026-10-25", at(1, 3), 100);
    const later = { ...dailyRow("later-day", "2026-10-25", at(0, 1), null), status };
    for (const rows of [[good, later], [later, good]]) {
      const report = assembleOwnerReport(buildInput({ accountDaily: rows }));
      assertEquals(report.account.daily[0].reach, status === "unavailable" ? null : 100);
      assertEquals(report.account.daily[0].status, status === "unavailable" ? status : "ok");
    }
  });

  Deno.test(`a later ${status} profile observation respects completed capture semantics`, () => {
    const good = PROFILE_ROWS[0];
    const later = { ...PROFILE_ROWS[1], status, followersCount: null, mediaCount: null };
    const report = assembleOwnerReport(buildInput({ profileObservations: [later, good] }));
    assertEquals(report.account.latestProfileObservation?.followersCount, status === "unavailable" ? null : 1200);
    assertEquals(report.account.latestProfileObservation?.status, status === "unavailable" ? status : "ok");
    assertEquals(report.account.profiles.length, 2);
  });
}

Deno.test("failed-only profile attempts are not presented as a completed observation", () => {
  const report = assembleOwnerReport(buildInput({
    profileObservations: [{ ...PROFILE_ROWS[0], status: "error", followersCount: null }],
  }));
  assertEquals(report.account.latestProfileObservation, null);
  assertEquals(report.account.profiles.length, 1);
});

Deno.test("the assembler refuses missing or null required completeness and freshness flags", () => {
  for (const [section, fields] of [
    ["freshness", ["partial", "truncated"]],
    ["completeness", ["baselineHistoryComplete", "inventoryTruncated"]],
  ] as const) {
    for (const field of fields) {
      for (const value of [undefined, null]) {
        const input = buildInput();
        const broken = { ...input, [section]: { ...input[section], [field]: value } };
        const error = assertThrows(() => assembleOwnerReport(broken as OwnerReportAssemblyInput), OwnerReportContractError);
        assertEquals(error.code, "INVALID_INPUT");
      }
    }
  }
});

for (const status of ["error", "pending", "unavailable"] as const) {
  Deno.test(`${status} rows never expose measurements supplied on an unsuccessful capture`, () => {
    const row = { ...dailyRow("attempt", "2026-10-25", at(0, 1), 999), status };
    const report = assembleOwnerReport(buildInput({
      accountDaily: [row],
      profileObservations: [{ ...PROFILE_ROWS[0], status }],
      mediaSnapshots: [mediaRow({ mediaId: "unavailable-media", publishedAt: at(2), status, reach: 999, likes: 9 })],
      baselineHistory: [],
    }));
    const daily = report.account.daily[0];
    for (const field of ["reach", "views", "accountsEngaged", "totalInteractions", "likes", "comments", "saves", "shares", "follows", "unfollows"] as const) {
      assertEquals(daily[field], null, field);
    }
    assertEquals(daily.status, status);
    assertEquals(daily.capturedAt, at(0, 1));
    assertEquals(report.account.profiles[0].followersCount, null);
    assertEquals(report.account.profiles[0].mediaCount, null);
    assertEquals(report.media.page.items.length, status === "unavailable" ? 1 : 0);
    for (const item of report.media.page.items) {
      assert(Object.values(item.metrics).every((value) => value === null));
      assertEquals(item.outlier.label, "no_data");
    }
  });
}

Deno.test("equivalent profile instants deduplicate identical observations and refuse contradictions", () => {
  const first = { ...PROFILE_ROWS[0], observedAt: "2026-10-24T03:10:00Z" };
  const same = { ...first, id: "other-id", observedAt: "2026-10-24T06:10:00+03:00" };
  for (const rows of [[first, same], [same, first]]) {
    const report = assembleOwnerReport(buildInput({ profileObservations: rows }));
    assertEquals(report.account.profiles.length, 1);
    assertEquals(report.account.latestProfileObservation?.followersCount, first.followersCount);
    const contradictory = rows.map((row, index) => index === 0 ? { ...row, followersCount: 999 } : row);
    const error = assertThrows(() => assembleOwnerReport(buildInput({ profileObservations: contradictory })), OwnerReportContractError);
    assertEquals(error.code, "CONFLICTING_CAPTURE_IDENTITY");
  }
});

Deno.test("equivalent daily and media capture instants cannot bypass capture identity", () => {
  const daily = dailyRow("day", "2026-10-25", "2026-10-26T03:00:00Z", 100);
  const media = mediaRow({ mediaId: "equivalent", publishedAt: at(2), capturedAt: "2026-10-26T03:00:00Z", reach: 100 });
  for (const reverse of [false, true]) {
    const days = [daily, { ...daily, id: "day-other", capturedAt: "2026-10-26T03:00:00+0000" }];
    const captures = [media, { ...media, id: "media-other", capturedAt: "2026-10-26T06:00:00+03:00" }];
    if (reverse) { days.reverse(); captures.reverse(); }
    assertEquals(assembleOwnerReport(buildInput({ accountDaily: days })).account.daily.length, 1);
    assertEquals(assembleOwnerReport(buildInput({ mediaSnapshots: captures, baselineHistory: [] })).media.page.items.length, 1);
    for (const input of [
      buildInput({ accountDaily: [days[0], { ...days[1], reach: 999 }] }),
      buildInput({ mediaSnapshots: [captures[0], { ...captures[1], reach: 999 }], baselineHistory: [] }),
    ]) {
      const error = assertThrows(() => assembleOwnerReport(input), OwnerReportContractError);
      assertEquals(error.code, "CONFLICTING_CAPTURE_IDENTITY");
    }
  }
});

Deno.test("distinct sub-millisecond captures remain distinct and newest wins independently of row id", () => {
  const earlier = { ...PROFILE_ROWS[0], id: "z-earlier", observedAt: "2026-10-24T03:10:00.123001Z", followersCount: 100 };
  const later = { ...earlier, id: "a-later", observedAt: "2026-10-24T03:10:00.123002Z", followersCount: 200 };
  for (const rows of [[earlier, later], [later, earlier]]) {
    const report = assembleOwnerReport(buildInput({ profileObservations: rows }));
    assertEquals(report.account.profiles.length, 2);
    assertEquals(report.account.latestProfileObservation?.followersCount, 200);
    assertEquals(report.account.latestProfileObservation?.observedAt, later.observedAt);
  }
});

Deno.test("daily and media selection preserve database microseconds rather than row-id ordering", () => {
  const daily = dailyRow("z-earlier", "2026-10-25", "2026-10-26T03:00:00.123001Z", 100);
  const media = mediaRow({ id: "z-earlier", mediaId: "micro", publishedAt: at(2), capturedAt: daily.capturedAt, reach: 100 });
  for (const reverse of [false, true]) {
    const days = [daily, { ...daily, id: "a-later", capturedAt: "2026-10-26T03:00:00.123002Z", reach: 200 }];
    const captures = [media, { ...media, id: "a-later", capturedAt: "2026-10-26T03:00:00.123002Z", reach: 200 }];
    if (reverse) { days.reverse(); captures.reverse(); }
    const report = assembleOwnerReport(buildInput({ accountDaily: days, mediaSnapshots: captures, baselineHistory: [] }));
    assertEquals(report.account.daily[0].reach, 200);
    assertEquals(report.media.page.items[0].metrics.reach, 200);
  }
});

Deno.test("equivalent fractional precision is one capture and microsecond page cursors remain truthful", () => {
  const profile = { ...PROFILE_ROWS[0], observedAt: "2026-10-24T03:10:00.123Z" };
  const duplicate = { ...profile, id: "same-capture", observedAt: "2026-10-24T06:10:00.123000+03:00" };
  assertEquals(assembleOwnerReport(buildInput({ profileObservations: [profile, duplicate] })).account.profiles.length, 1);
  const rows = [
    mediaRow({ mediaId: "a-earlier", publishedAt: "2026-10-24T03:10:00.123001Z", reach: 100 }),
    mediaRow({ mediaId: "z-later", publishedAt: "2026-10-24T03:10:00.123002Z", reach: 200 }),
  ];
  const first = assembleOwnerReport(buildInput({ mediaSnapshots: rows, baselineHistory: [], request: { periodDays: 7, limit: 1, cursor: null } }));
  assertEquals(first.media.page.items[0].mediaId, "z-later");
  const second = assembleOwnerReport(buildInput({ mediaSnapshots: rows, baselineHistory: [], request: { periodDays: 7, limit: 1, cursor: first.media.page.nextCursor } }));
  assertEquals(second.media.page.items[0].mediaId, "a-earlier");
  assertEquals(second.media.page.hasMore, false);
});

function itemOf(report: ReturnType<typeof assembleOwnerReport>, mediaId: string) {
  const item = report.media.page.items.find((entry) => entry.mediaId === mediaId);
  assertExists(item, `media "${mediaId}" must be in the report`);
  return item;
}

/* -------------------------------------------------------------------------- */
/* The canonical scorer is really the scorer                                    */
/* -------------------------------------------------------------------------- */

Deno.test("the outlier score comes from the canonical algorithm, not a copy", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d1");

  // The same cohort the assembler scores: non-reel media that has a reach.
  const cohort = [...REACH_HISTORY, ...DISPLAY_MEDIA]
    .filter((row): row is MediaSnapshotRow & { reach: number } =>
      row.mediaProductType === "FEED" && row.reach !== null && row.reach !== undefined
    )
    .filter((row) => row.publishedAt <= NOW.toISOString())
    .map((row) => ({
      id: row.mediaId,
      format: "non_reel" as const,
      publishedAt: row.publishedAt,
      value: row.reach,
    }));
  const canonical = computeOutlierScores(cohort, NOW).find((entry) => entry.id === "d1");
  assertExists(canonical);

  assertEquals(item.outlier.score, canonical.score);
  assertEquals(item.outlier.label, canonical.label);
  assertEquals(item.outlier.baselineMedian, canonical.baselineMedian);
  assertEquals(item.outlier.baselineSize, canonical.baselineSize);
  assertEquals(item.outlier.score, 5);
  assertEquals(item.outlier.label, "outlier");
  assertEquals(item.outlier.baselineSize, 11);
});

Deno.test("the baseline is not reduced by a shorter display period", () => {
  const seven = assembleOwnerReport(buildInput());
  const ninety = assembleOwnerReport(buildInput({
    request: { periodDays: 90, limit: 100, cursor: null },
    mediaSnapshots: ALL_MEDIA,
  }));

  const short = itemOf(seven, "d1");
  const long = itemOf(ninety, "d1");
  assertEquals(short.outlier.score, long.outlier.score);
  assertEquals(short.outlier.label, long.outlier.label);
  assertEquals(short.outlier.baselineMedian, long.outlier.baselineMedian);
  assertEquals(short.outlier.baselineSize, long.outlier.baselineSize);
  assertEquals(long.outlier.baselineSize, 11);
});

Deno.test("the baseline is not reduced by the display page", () => {
  const report = assembleOwnerReport(buildInput({
    request: { periodDays: 7, limit: 2, cursor: null },
  }));
  assertEquals(report.media.page.items.length, 2);
  const item = itemOf(report, "d1");
  assertEquals(item.outlier.baselineSize, 11);
  assertEquals(item.outlier.score, 5);
});

/* -------------------------------------------------------------------------- */
/* Latest capture per media                                                     */
/* -------------------------------------------------------------------------- */

Deno.test("the latest capture per media is selected before the display filter", () => {
  const report = assembleOwnerReport(buildInput());
  const ids = report.media.page.items.map((item) => item.mediaId);
  assertEquals(new Set(ids).size, ids.length, "a media must appear once");
  assertEquals(ids.includes("d1"), true);
});

Deno.test("a later failed capture does not erase the metrics an earlier capture recorded", () => {
  const failed = mediaRow({
    mediaId: "d1",
    id: "snap-d1-failed",
    publishedAt: at(2),
    capturedAt: at(0, 1),
    status: "error",
    reach: null,
    views: null,
    likes: null,
    comments: null,
    saved: null,
    shares: null,
  });
  const report = assembleOwnerReport(buildInput({
    mediaSnapshots: [...DISPLAY_MEDIA, failed],
    baselineHistory: [...ALL_MEDIA, failed],
  }));
  const item = itemOf(report, "d1");
  assertEquals(item.metrics.reach, 500);
  assertEquals(item.outlier.score, 5);
});

Deno.test("two rows that claim the same capture but disagree are refused", () => {
  const capturedAt = at(0, 6);
  const first = mediaRow({ mediaId: "d1", id: "snap-a", publishedAt: at(2), capturedAt, reach: 500 });
  const second = mediaRow({ mediaId: "d1", id: "snap-b", publishedAt: at(2), capturedAt, reach: 501 });
  const error = assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        mediaSnapshots: [...DISPLAY_MEDIA, first, second],
        baselineHistory: [...ALL_MEDIA, first, second],
      })),
    OwnerReportContractError,
  );
  assertEquals(error.code, "CONFLICTING_CAPTURE_IDENTITY");
});

Deno.test("the report is deterministic whatever order the rows arrive in", () => {
  const ordered = assembleOwnerReport(buildInput());
  const shuffled = assembleOwnerReport(buildInput({
    mediaSnapshots: [...DISPLAY_MEDIA].reverse(),
    baselineHistory: [...ALL_MEDIA].reverse(),
    accountDaily: [...DAILY_ROWS].reverse(),
    profileObservations: [...PROFILE_ROWS].reverse(),
  }));
  assertEquals(JSON.stringify(shuffled), JSON.stringify(ordered));
});

/* -------------------------------------------------------------------------- */
/* Scope                                                                        */
/* -------------------------------------------------------------------------- */

Deno.test("a row from another account is refused, never mixed in", () => {
  const foreign = mediaRow({
    mediaId: "foreign",
    publishedAt: at(1),
    socialAccountId: OTHER_ACCOUNT_ID,
    reach: 900,
  });
  const error = assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        mediaSnapshots: [...DISPLAY_MEDIA, foreign],
        baselineHistory: [...ALL_MEDIA, foreign],
      })),
    OwnerReportContractError,
  );
  assertEquals(error.code, "ACCOUNT_MISMATCH");
});

Deno.test("a row from another owner is refused", () => {
  const foreign = mediaRow({
    mediaId: "foreign-owner",
    publishedAt: at(1),
    ownerId: OTHER_ACCOUNT_ID,
    reach: 900,
  });
  const error = assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        mediaSnapshots: [...DISPLAY_MEDIA, foreign],
        baselineHistory: [...ALL_MEDIA, foreign],
      })),
    OwnerReportContractError,
  );
  assertEquals(error.code, "ACCOUNT_MISMATCH");
});

Deno.test("the report carries the scope it was read for and the owner source", () => {
  const report = assembleOwnerReport(buildInput());
  assertEquals(report.scope.ownerId, OWNER_ID);
  assertEquals(report.scope.socialAccountId, ACCOUNT_ID);
  assertEquals(report.scope.platform, "instagram");
  assertEquals(report.source, "graph_own");
  assertEquals(report.schemaVersion, 1);
});

/* -------------------------------------------------------------------------- */
/* Classification and cohorts                                                   */
/* -------------------------------------------------------------------------- */

Deno.test("an unknown product type is not guessed into a format", () => {
  const report = assembleOwnerReport(buildInput());
  const ids = report.media.page.items.map((item) => item.mediaId);
  assertEquals(ids.includes("d7"), false, "an unclassified media is not displayed");
  assertEquals(report.media.coverage.excludedUnknown, 1);
  assertEquals(report.media.coverage.reel, 2);
});

Deno.test("a video feed post is not a reel", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d9");
  assertEquals(item.format, "non_reel");
  assertEquals(item.mediaType, "VIDEO");
  assertEquals(item.outlier.metricBasis, "reach");
});

Deno.test("stories are excluded instead of pretending to be supported", () => {
  const report = assembleOwnerReport(buildInput());
  const ids = report.media.page.items.map((item) => item.mediaId);
  assertEquals(ids.includes("d8"), false);
  assertEquals(report.media.coverage.excludedStory, 1);
});

Deno.test("reach and interactions never share a median", () => {
  const report = assembleOwnerReport(buildInput());
  const reachItem = itemOf(report, "d1");
  const interactionItem = itemOf(report, "d3");

  assertEquals(reachItem.outlier.metricBasis, "reach");
  assertEquals(reachItem.outlier.baselineMedian, 100);
  assertEquals(interactionItem.outlier.metricBasis, "interactions");
  assertEquals(interactionItem.outlier.baselineMedian, 50);
  assertEquals(interactionItem.outlier.score, 1.2);
});

Deno.test("reels and non-reels never share a baseline", () => {
  const report = assembleOwnerReport(buildInput());
  const reel = itemOf(report, "d2");
  const post = itemOf(report, "d1");
  assertEquals(reel.outlier.metricBasis, "views");
  assertEquals(reel.outlier.baselineMedian, 200);
  assertEquals(reel.outlier.score, 5);
  assertEquals(post.outlier.baselineMedian, 100);
});

/* -------------------------------------------------------------------------- */
/* Null is unavailable, never zero                                              */
/* -------------------------------------------------------------------------- */

Deno.test("a reel without views stays null instead of falling back to reach", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d10");
  assertEquals(item.metrics.views, null);
  assertEquals(item.metrics.reach, 900);
  assertEquals(item.outlier.label, "no_data");
  assertEquals(item.outlier.score, null);
  assertEquals(item.outlier.metricBasis, null);
});

Deno.test("a media without any metric reports no data", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d4");
  assertEquals(item.metrics.reach, null);
  assertEquals(item.metrics.likes, null);
  assertEquals(item.outlier.label, "no_data");
  assertEquals(item.outlier.score, null);
  assertEquals(item.engagementRate.value, null);
});

Deno.test("a zero reach is a measurement, not a missing value", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d11");
  assertEquals(item.metrics.reach, 0);
  assertEquals(item.engagementRate.value, null, "a zero denominator has no rate");
  assertEquals(item.outlier.label, "below");
  assertEquals(item.outlier.score, 0);
});

Deno.test("one missing numerator makes the whole engagement rate unavailable", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d12");
  assertEquals(item.metrics.likes, 10);
  assertEquals(item.metrics.comments, null);
  assertEquals(item.engagementRate.value, null);
});

Deno.test("the engagement rate is a percentage of reach with a stated basis", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d1");
  assertEquals(item.engagementRate.value, 13);
  assertEquals(item.engagementRate.unit, "percent");
  assertEquals(item.engagementRate.denominatorMetric, "reach");
  assertEquals(item.engagementRate.numeratorMetrics, ["likes", "comments", "saved", "shares"]);
});

/* -------------------------------------------------------------------------- */
/* Maturity, future rows and the display window                                */
/* -------------------------------------------------------------------------- */

Deno.test("an immature media is too early and is not scored", () => {
  const report = assembleOwnerReport(buildInput());
  const item = itemOf(report, "d5");
  assertEquals(item.outlier.label, "too_early");
  assertEquals(item.outlier.score, null);
});

Deno.test("a media published in the future is not displayed", () => {
  const report = assembleOwnerReport(buildInput());
  const ids = report.media.page.items.map((item) => item.mediaId);
  assertEquals(ids.includes("d6"), false);
  assertEquals(report.media.coverage.excludedFuture, 1);
});

Deno.test("the display window is filtered by published_at, not by captured_on", () => {
  // A media published inside the window whose capture happened in an
  // earlier day is displayed; a media published outside it is not.
  const inside = mediaRow({
    mediaId: "inside",
    publishedAt: at(1),
    capturedAt: "2026-10-01T03:00:00.000Z",
    capturedOn: "2026-10-01",
    reach: 100,
  });
  const outside = mediaRow({
    mediaId: "outside",
    publishedAt: at(20),
    capturedAt: "2026-10-26T03:00:00.000Z",
    capturedOn: "2026-10-26",
    reach: 100,
  });
  const report = assembleOwnerReport(buildInput({
    mediaSnapshots: [...DISPLAY_MEDIA, inside, outside],
    baselineHistory: [...ALL_MEDIA, inside, outside],
  }));
  const ids = report.media.page.items.map((item) => item.mediaId);
  assertEquals(ids.includes("inside"), true);
  assertEquals(ids.includes("outside"), false);
});

/* -------------------------------------------------------------------------- */
/* Account days and profile observations                                        */
/* -------------------------------------------------------------------------- */

Deno.test("one row per metric day survives, the newest capture wins", () => {
  const report = assembleOwnerReport(buildInput());
  const dates = report.account.daily.map((row) => row.metricDate);
  assertEquals(new Set(dates).size, dates.length);
  assertEquals(dates.includes("2026-10-24"), true);
  const day = report.account.daily.find((row) => row.metricDate === "2026-10-24");
  assertExists(day);
  assertEquals(day.reach, 145, "the newest capture of the day wins");
  assertEquals(day.capturedAt, "2026-10-26T09:00:00.000Z");
});

Deno.test("the account days are bounded by the period window", () => {
  const report = assembleOwnerReport(buildInput());
  const dates = report.account.daily.map((row) => row.metricDate);
  assertEquals(dates.includes("2026-10-10"), false, "a day outside the window is dropped");
  assertEquals(dates[0], "2026-10-20");
  assertEquals(dates[dates.length - 1], "2026-10-26");
  assertEquals(report.period.metricDateStart, "2026-10-20");
  assertEquals(report.period.metricDateEnd, "2026-10-26");
});

Deno.test("the provider day and window are carried through untouched", () => {
  const report = assembleOwnerReport(buildInput());
  const day = report.account.daily.find((row) => row.metricDate === "2026-10-25");
  assertExists(day);
  assertEquals(day.providerDate, "2026-10-25");
  assertEquals(day.providerTimezone, "Asia/Kuwait");
  assertEquals(day.periodStart, "2026-10-25T00:00:00.000Z");
});

Deno.test("followers stay a point-in-time observation, never a metric day", () => {
  const report = assembleOwnerReport(buildInput());
  const day = report.account.daily.find((row) => row.metricDate === "2026-10-25");
  assertExists(day);
  assertEquals("followersCount" in day, false);
  assertEquals(report.account.profiles.length, 2);
  const latest = report.account.latestProfileObservation;
  assertExists(latest);
  assertEquals(latest.followersCount, 1250);
  assertEquals(latest.observedOn, "2026-10-26");
  assertEquals(report.account.daily.some((row) => row.metricDate === latest.observedOn), true);
});

/* -------------------------------------------------------------------------- */
/* Freshness and completeness                                                   */
/* -------------------------------------------------------------------------- */

Deno.test("a failed attempt does not advance the last successful sync", () => {
  const report = assembleOwnerReport(buildInput());
  assertEquals(report.freshness.status, "error");
  assertEquals(report.freshness.lastAttemptAt, "2026-10-26T11:00:00.000Z");
  assertEquals(report.freshness.lastSuccessAt, "2026-10-24T03:00:00.000Z");
  assertEquals(report.freshness.lastPartialAt, "2026-10-25T03:00:00.000Z");
  assertEquals(report.freshness.retryAt, "2026-10-27T03:00:00.000Z");
  assertEquals(report.freshness.reason, "provider_error");
  assert(report.media.page.items.length > 0, "a failed sync must not hide the history");
});

Deno.test("partial and truncated signals reach the report unchanged", () => {
  const report = assembleOwnerReport(buildInput({
    freshness: {
      ...FRESHNESS,
      status: "partial",
      partial: true,
      truncated: true,
      reason: "inventory_truncated",
    },
    completeness: {
      ...COMPLETENESS,
      baselineHistoryComplete: false,
      inventoryTruncated: true,
      coverage: "partial",
    },
  }));
  assertEquals(report.freshness.partial, true);
  assertEquals(report.freshness.truncated, true);
  assertEquals(report.freshness.reason, "inventory_truncated");
  assertEquals(report.completeness.baselineHistoryComplete, false);
  assertEquals(report.completeness.inventoryTruncated, true);
  assertEquals(report.completeness.coverage, "partial");
});

Deno.test("the lag note is a stable code and not prose", () => {
  const report = assembleOwnerReport(buildInput());
  assertEquals(report.lagNote, OWNER_REPORT_LAG_NOTE);
  assertEquals(report.lagNote.includes(" "), false);
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                   */
/* -------------------------------------------------------------------------- */

Deno.test("the page is bounded and the cursor is truthful", () => {
  const whole = assembleOwnerReport(buildInput());
  const collected: string[] = [];
  let cursor: { publishedAt: string; mediaId: string } | null = null;

  for (let page = 0; page < 20; page += 1) {
    const result = assembleOwnerReport(buildInput({
      request: { periodDays: 7, limit: 3, cursor },
    }));
    assert(result.media.page.items.length <= 3, "a page is never larger than its limit");
    const ids = result.media.page.items.map((item) => item.mediaId);
    assertEquals(
      ids.filter((id) => collected.includes(id)).length,
      0,
      "two pages must not repeat a media",
    );
    collected.push(...ids);

    if (!result.media.page.hasMore) {
      assertEquals(result.media.page.nextCursor, null);
      break;
    }
    assertExists(result.media.page.nextCursor);
    cursor = result.media.page.nextCursor;
  }

  assertEquals(collected, whole.media.page.items.map((item) => item.mediaId));
  assertEquals(new Set(collected).size, collected.length);
});

Deno.test("the last page has no cursor and reports no more", () => {
  const report = assembleOwnerReport(buildInput({
    request: { periodDays: 7, limit: 100, cursor: null },
  }));
  assertEquals(report.media.page.hasMore, false);
  assertEquals(report.media.page.nextCursor, null);
  assert(report.media.page.items.length <= report.media.page.limit);
});

Deno.test("paging does not change the score of a media", () => {
  const whole = assembleOwnerReport(buildInput());
  const page = assembleOwnerReport(buildInput({
    request: { periodDays: 7, limit: 2, cursor: null },
  }));
  const wholeItem = itemOf(whole, "d1");
  const pageItem = itemOf(page, "d1");
  assertEquals(pageItem.outlier.score, wholeItem.outlier.score);
  assertEquals(pageItem.outlier.baselineSize, wholeItem.outlier.baselineSize);
});

/* -------------------------------------------------------------------------- */
/* Boundary validation                                                          */
/* -------------------------------------------------------------------------- */

Deno.test("only 7, 14, 30 and 90 day periods are accepted", () => {
  assertEquals(parseOwnerReportRequest({ periodDays: 7 }).periodDays, 7);
  assertEquals(parseOwnerReportRequest({ periodDays: "14" }).periodDays, 14);
  assertEquals(parseOwnerReportRequest({ periodDays: 30 }).periodDays, 30);
  assertEquals(parseOwnerReportRequest({ periodDays: 90 }).periodDays, 90);

  const error = assertThrows(
    () => parseOwnerReportRequest({ periodDays: 10 }),
    OwnerReportContractError,
  );
  assertEquals(error.code, "INVALID_PERIOD");
  assertThrows(() => parseOwnerReportRequest({ periodDays: 0 }), OwnerReportContractError);
  assertThrows(() => parseOwnerReportRequest({ periodDays: 365 }), OwnerReportContractError);
});

Deno.test("the page size is bounded", () => {
  assertEquals(parseOwnerReportRequest({ periodDays: 7 }).limit, 20);
  assertEquals(parseOwnerReportRequest({ periodDays: 7, limit: 5 }).limit, 5);
  const error = assertThrows(
    () => parseOwnerReportRequest({ periodDays: 7, limit: OWNER_REPORT_MAX_LIMIT + 1 }),
    OwnerReportContractError,
  );
  assertEquals(error.code, "INVALID_LIMIT");
  assertThrows(() => parseOwnerReportRequest({ periodDays: 7, limit: 0 }), OwnerReportContractError);
});

Deno.test("a malformed cursor is refused", () => {
  const error = assertThrows(
    () => parseOwnerReportRequest({ periodDays: 7, cursor: { publishedAt: "yesterday", mediaId: "x" } }),
    OwnerReportContractError,
  );
  assertEquals(error.code, "INVALID_CURSOR");
  assertThrows(
    () => parseOwnerReportRequest({ periodDays: 7, cursor: { publishedAt: "2026-10-26T00:00:00Z", mediaId: "" } }),
    OwnerReportContractError,
  );
  assertEquals(
    parseOwnerReportRequest({
      periodDays: 7,
      cursor: { publishedAt: "2026-10-26T00:00:00.000Z", mediaId: "d1" },
    }).cursor?.mediaId,
    "d1",
  );
});

/* -------------------------------------------------------------------------- */
/* Serialisation                                                                */
/* -------------------------------------------------------------------------- */

function assertEveryNumberIsFinite(value: unknown, path: string): void {
  if (typeof value === "number") {
    assert(Number.isFinite(value), `${path} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertEveryNumberIsFinite(entry, `${path}[${index}]`));
    return;
  }
  if (typeof value === "object" && value !== null) {
    for (const [key, entry] of Object.entries(value)) {
      assertEveryNumberIsFinite(entry, `${path}.${key}`);
    }
  }
}

Deno.test("the serialised report carries no non-finite number and no credential", () => {
  const report = assembleOwnerReport(buildInput());
  assertEveryNumberIsFinite(report, "report");
  const json = JSON.stringify(report);
  assertEquals(json.includes("NaN"), false);
  assertEquals(json.includes("Infinity"), false);
  const forbidden = [
    "access_token",
    "refresh_token",
    "api_key",
    "apikey",
    "password",
    "secret",
    "authorization",
    "credential",
  ];
  const lowered = json.toLowerCase();
  for (const key of forbidden) {
    assertEquals(lowered.includes(key), false, `the report must not contain "${key}"`);
  }
});

Deno.test("a non-finite metric is unavailable, not a number", () => {
  const broken = mediaRow({
    mediaId: "d1",
    id: "snap-broken",
    publishedAt: at(2),
    reach: Number.POSITIVE_INFINITY,
  });
  const report = assembleOwnerReport(buildInput({
    mediaSnapshots: [...DISPLAY_MEDIA.filter((row) => row.mediaId !== "d1"), broken],
    baselineHistory: [...ALL_MEDIA.filter((row) => row.mediaId !== "d1"), broken],
  }));
  const item = itemOf(report, "d1");
  assertEquals(item.metrics.reach, null);
  assertEveryNumberIsFinite(report, "report");
});

Deno.test("a flag that is not a boolean is refused instead of read as false", () => {
  const error = assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        freshness: { ...FRESHNESS, partial: "yes" } as unknown as OwnerReportFreshnessInput,
      })),
    OwnerReportContractError,
  );
  assertEquals(error.code, "INVALID_INPUT");
});

Deno.test("a broken request or collection is refused", () => {
  assertThrows(
    () => assembleOwnerReport(buildInput({ request: undefined as unknown as OwnerReportRequest })),
    OwnerReportContractError,
  );
  assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        mediaSnapshots: undefined as unknown as MediaSnapshotRow[],
      })),
    OwnerReportContractError,
  );
});

Deno.test("a row with an unusable publication instant is refused", () => {
  const broken = mediaRow({ mediaId: "d1", id: "snap-bad-date", publishedAt: "last tuesday" });
  const error = assertThrows(
    () =>
      assembleOwnerReport(buildInput({
        mediaSnapshots: [...DISPLAY_MEDIA, broken],
        baselineHistory: [...ALL_MEDIA, broken],
      })),
    OwnerReportContractError,
  );
  assertEquals(error.code, "INVALID_ROW");
});

Deno.test("the report never grows past the period or the page", () => {
  const report = assembleOwnerReport(buildInput({
    request: { periodDays: 7, limit: 4, cursor: null },
  }));
  assert(report.media.page.items.length <= 4);
  assert(report.account.daily.length <= 7);
  assert(report.account.profiles.length <= DAILY_ROWS.length);
});
