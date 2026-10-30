/**
 * The pure assembler of the competitor tracking report.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - The public DTO has the shape of spec §5: the version, the server
 *     timestamp, the capture timezone, the four-key quota and the cursor.
 *   - The outlier verdict is the CANONICAL one: the 48 hour maturity, the six
 *     and twelve baseline boundaries, the zero median and the inclusive
 *     thresholds - all of them produced by `_shared/outlierScore.ts` and by
 *     no second implementation.
 *   - The score of an item does not depend on the requested display period.
 *   - A malformed payload is a FAILED READ, never an empty report.
 *   - A URL is projected only when it is safe, and a caption is plain text.
 *   - The payload the real database actually returned assembles.
 *
 * THE CAPTURED FIXTURE
 *
 *   `fixtures/captured-report.json` is the RAW projection that
 *   `read_own_competitor_tracking_report` returned on the disposable Task 8
 *   harness (supabase/postgres:17.6.1.158, the repository db-harness plus
 *   the M1/M2 migrations). It was captured by seeding ONE synthetic owner
 *   (e1000000-0000-4000-8000-0000000000a1), one tracked entry
 *   (e2000000-0000-4000-8000-0000000000b1, handle `fixture_competitor`),
 *   two profile observations, eleven media, one committed capture coverage
 *   row and one collection job, then reading the detail as that owner.
 *
 *   Every value in it is synthetic: the URLs point at example.invalid, the
 *   media are `fixture_reel_*` and no credential, token, lease, claim or
 *   real account appears in it.
 */

import {
  assert,
  assertEquals,
  assertThrows,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  CompetitorReportContractError,
  type CompetitorReportDetail,
  type CompetitorReportList,
  type CompetitorReportRequest,
  type RawEntry,
  type RawMedia,
  type RawReportProjection,
} from "./contracts.ts";
import { assembleCompetitorReport } from "./assemble.ts";
import { COMPETITOR_REPORT_BASELINE_POLICY } from "./growth.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const CAPTURED_FIXTURE = join(HERE, "fixtures", "captured-report.json");

/** The instant every fixture is scored at. */
const NOW = new Date("2026-10-30T12:00:00.000Z");

function listRequest(): CompetitorReportRequest {
  return { action: "list", state: "active", limit: 20, cursor: null };
}

function detailRequest(): CompetitorReportRequest {
  return {
    action: "detail",
    watchlistId: "d2000000-0000-4000-8000-000000000001",
    periodDays: 7,
    limit: 20,
    cursor: null,
  };
}

function rawEntry(overrides: Partial<RawEntry> = {}): RawEntry {
  return {
    watchlist_id: "d2000000-0000-4000-8000-000000000001",
    username: "rich",
    label: "Rich",
    is_active: true,
    removed_at: null,
    status: "ok",
    last_error_code: null,
    next_retry_at: null,
    source: "official",
    cleanup_eligible_at: null,
    created_at: "2026-01-01T00:00:00.000001+00:00",
    profile: {
      followers_count: 1000,
      media_count: 50,
      captured_at: "2026-10-20T12:00:00+00:00",
      captured_on: "2026-10-20",
      source: "official",
    },
    observations: [],
    observations_truncated: false,
    growth: {
      "7": {
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
      },
      "30": {
        period_days: 30,
        reason: null,
        observed_at: "2026-10-20T12:00:00+00:00",
        observed_followers: 1000,
        observed_source: "official",
        baseline_at: "2026-09-20T12:00:00+00:00",
        baseline_followers: 800,
        interval_days: 30,
        interval_seconds: 2592000,
        absolute: 200,
        percent: 25,
      },
    },
    coverage: [],
    coverage_truncated: false,
    job: null,
    ...overrides,
  };
}

function rawMedia(
  igMediaId: string,
  publishedAt: string,
  overrides: Partial<RawMedia> = {},
): RawMedia {
  return {
    ig_media_id: igMediaId,
    published_at: publishedAt,
    captured_at: "2026-10-20T12:00:00+00:00",
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

function projection(
  entries: RawEntry[],
  media: RawMedia[] = [],
  overrides: Partial<RawReportProjection> = {},
): RawReportProjection {
  return {
    version: 1,
    action: "list",
    as_of: "2026-10-30T11:59:59.123456+00:00",
    capture_timezone: "Asia/Kuwait",
    quota: {
      max_tracked_competitors: 20,
      unlimited: false,
      tracked_active: 3,
      remaining: 17,
    },
    next_cursor: null,
    entries,
    entry: null,
    media,
    ...overrides,
  };
}

/**
 * A cohort of `count` earlier media with the same value.
 *
 * They are published one day apart and are all mature at NOW.
 */
function cohort(count: number, value: number): RawMedia["baseline"] {
  const items: RawMedia["baseline"] = [];
  for (let index = 0; index < count; index += 1) {
    const day = String(18 - index).padStart(2, "0");
    items.push({
      ig_media_id: `m_${String(index).padStart(2, "0")}`,
      published_at: `2026-10-${day}T09:00:00+00:00`,
      captured_at: "2026-10-20T12:00:00+00:00",
      source: "official",
      metric_basis: "public_views",
      value,
    });
  }
  return items;
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                                  */
/* -------------------------------------------------------------------------- */

Deno.test("the list envelope carries the version, the timezone and the quota", () => {
  const report = assembleCompetitorReport(
    { action: "list", request: listRequest(), raw: projection([rawEntry()]) },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportList;

  assertEquals(report.version, 1);
  assertEquals(report.capture_timezone, "Asia/Kuwait");
  assertEquals(report.as_of, "2026-10-30T11:59:59.123456+00:00");
  assertEquals(report.quota, {
    max_tracked_competitors: 20,
    unlimited: false,
    tracked_active: 3,
    remaining: 17,
  });
  assertEquals(report.next_cursor, null);
  assertEquals(report.entries.length, 1);
  assertEquals(report.entries[0]!.username, "rich");
  assertEquals(report.entries[0]!.growth_7d.absolute, 100);
  assertEquals(report.entries[0]!.growth_30d.percent, 25);
  assertEquals(report.entries[0]!.profile!.followers_count, 1000);
});

Deno.test("the detail envelope carries the entry and the media", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [rawMedia("m1", "2026-10-19T09:00:00+00:00")], {
        action: "detail",
        entry: rawEntry(),
      }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.entry!.watchlist_id, "d2000000-0000-4000-8000-000000000001");
  assertEquals(report.media.length, 1);
  assertEquals(report.media[0]!.ig_media_id, "m1");
});

Deno.test("the cursor is passed through verbatim", () => {
  const cursor = "eyJ2IjoxLCJvIjoiZCIsImYiOiJhYmMifQ";
  const report = assembleCompetitorReport(
    {
      action: "list",
      request: listRequest(),
      raw: projection([rawEntry()], [], { next_cursor: cursor }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportList;

  assertEquals(report.next_cursor, cursor);
});

Deno.test("an entry never carries the owner and never carries the raw error", () => {
  const report = assembleCompetitorReport(
    {
      action: "list",
      request: listRequest(),
      raw: projection([rawEntry({ last_error_code: "token_invalid" })]),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportList;

  const serialized = JSON.stringify(report);
  assertEquals("user_id" in report.entries[0]!, false);
  assertEquals("last_error" in report.entries[0]!, false);
  assertEquals(serialized.includes("user_id"), false);
  assertEquals(report.entries[0]!.last_error_code, "token_invalid");
});

Deno.test("a removed entry carries its cleanup date", () => {
  const report = assembleCompetitorReport(
    {
      action: "list",
      request: listRequest(),
      raw: projection([
        rawEntry({
          is_active: false,
          removed_at: "2026-05-01T00:00:00+00:00",
          cleanup_eligible_at: "2026-07-30T00:00:00+00:00",
        }),
      ]),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportList;

  assertEquals(report.entries[0]!.removed_at, "2026-05-01T00:00:00+00:00");
  assertEquals(report.entries[0]!.cleanup_eligible_at, "2026-07-30T00:00:00+00:00");
});

/* -------------------------------------------------------------------------- */
/* The outliers                                                                  */
/* -------------------------------------------------------------------------- */

Deno.test("an item is scored against its own cohort", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(6, 100),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const outlier = report.media[0]!.outlier;
  assertEquals(outlier.id, "m_target");
  assertEquals(outlier.score, 3);
  assertEquals(outlier.label, "outlier");
  assertEquals(outlier.baselineMedian, 100);
  assertEquals(outlier.baselineSize, 6);
  assertEquals(outlier.metric_basis, "public_views");
  assertEquals(outlier.source, "official");
  assertEquals(outlier.reason, null);
});

Deno.test("six earlier media are enough and five are not", () => {
  const six = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(6, 100),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(six.media[0]!.outlier.label, "outlier");
  assertEquals(six.media[0]!.outlier.baselineSize, 6);

  const five = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(5, 100),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(five.media[0]!.outlier.label, "small_baseline");
  assertEquals(five.media[0]!.outlier.score, null);
  assertEquals(five.media[0]!.outlier.baselineSize, 5);
  assertEquals(five.media[0]!.outlier.reason, "small_baseline");
});

Deno.test("the baseline holds at most twelve earlier media", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(14, 100),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.outlier.baselineSize, 12);
});

Deno.test("a zero median produces no data", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(6, 0),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const outlier = report.media[0]!.outlier;
  assertEquals(outlier.label, "no_data");
  assertEquals(outlier.score, null);
  assertEquals(outlier.baselineMedian, 0);
  assertEquals(outlier.baselineSize, 6);
  assertEquals(outlier.reason, "no_data");
});

Deno.test("the thresholds are inclusive at the boundary", () => {
  const scored = (value: number) => {
    const report = assembleCompetitorReport(
      {
        action: "detail",
        request: detailRequest(),
        raw: projection([], [
          rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
            view_count: value,
            baseline: cohort(6, 100),
          }),
        ], { action: "detail", entry: rawEntry() }),
      },
      NOW,
      COMPETITOR_REPORT_BASELINE_POLICY,
    ) as CompetitorReportDetail;
    return report.media[0]!.outlier;
  };

  assertEquals(scored(300).label, "outlier");
  assertEquals(scored(300).score, 3);
  assertEquals(scored(150).label, "above");
  assertEquals(scored(150).score, 1.5);
  assertEquals(scored(100).label, "normal");
  assertEquals(scored(100).score, 1);
  assertEquals(scored(50).label, "below");
  assertEquals(scored(50).score, 0.5);
});

Deno.test("an item that is younger than forty-eight hours is too early", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-28T13:00:00+00:00", {
          view_count: 300,
          baseline: cohort(6, 100),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.outlier.label, "too_early");
  assertEquals(report.media[0]!.outlier.score, null);
  assertEquals(report.media[0]!.outlier.reason, "too_early");
});

Deno.test("the cohorts do not mix", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: cohort(6, 100).map((candidate) => ({
            ...candidate,
            metric_basis: "public_interactions",
          })),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.outlier.label, "small_baseline");
  assertEquals(report.media[0]!.outlier.baselineSize, 0);
});

Deno.test("a baseline that could not be proven carries no score", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          view_count: 300,
          baseline: [],
          baseline_incomplete: true,
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const outlier = report.media[0]!.outlier;
  assertEquals(outlier.label, "no_data");
  assertEquals(outlier.score, null);
  assertEquals(outlier.baselineSize, 0);
  assertEquals(outlier.reason, "baseline_incomplete");
});

Deno.test("an unknown product type has no metric basis and no score", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          media_product_type: null,
          metric_basis: null,
          view_count: 300,
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const outlier = report.media[0]!.outlier;
  assertEquals(outlier.metric_basis, null);
  assertEquals(outlier.label, "no_data");
  assertEquals(outlier.score, null);
  assertEquals(outlier.reason, "no_metric_basis");
});

Deno.test("a feed is measured by its public interactions", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          media_product_type: "FEED",
          metric_basis: "public_interactions",
          view_count: null,
          like_count: 300,
          comments_count: 300,
          baseline: cohort(6, 100).map((candidate) => ({
            ...candidate,
            metric_basis: "public_interactions",
          })),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const outlier = report.media[0]!.outlier;
  assertEquals(outlier.metric_basis, "public_interactions");
  assertEquals(outlier.score, 6);
  assertEquals(outlier.label, "outlier");
});

Deno.test("a feed without comments has no value at all", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          media_product_type: "FEED",
          metric_basis: "public_interactions",
          view_count: null,
          like_count: 300,
          comments_count: null,
          baseline: cohort(6, 100).map((candidate) => ({
            ...candidate,
            metric_basis: "public_interactions",
          })),
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.outlier.label, "no_data");
  assertEquals(report.media[0]!.outlier.score, null);
});

Deno.test("the score does not depend on the requested display period", () => {
  const media = [rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
    view_count: 300,
    baseline: cohort(6, 100),
  })];

  const seven = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], media, { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const thirty = assembleCompetitorReport(
    {
      action: "detail",
      request: {
        action: "detail",
        watchlistId: "d2000000-0000-4000-8000-000000000001",
        periodDays: 30,
        limit: 20,
        cursor: null,
      },
      raw: projection([], media, { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(seven.media[0]!.outlier.score, thirty.media[0]!.outlier.score);
  assertEquals(seven.media[0]!.outlier.label, thirty.media[0]!.outlier.label);
  assertEquals(seven.media[0]!.outlier.baselineSize, thirty.media[0]!.outlier.baselineSize);
});

/* -------------------------------------------------------------------------- */
/* The projections                                                               */
/* -------------------------------------------------------------------------- */

Deno.test("an unsafe URL is dropped and a safe one is kept", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          thumbnail_url: "javascript:alert(1)",
          permalink: "https://www.instagram.com/p/abc/",
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.thumbnail_url, null);
  assertEquals(report.media[0]!.permalink, "https://www.instagram.com/p/abc/");
});

Deno.test("a URL that carries credentials is dropped", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          permalink: "https://user:secret@example.com/p/abc/",
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  assertEquals(report.media[0]!.permalink, null);
});

Deno.test("a caption is plain text and never markup", () => {
  const report = assembleCompetitorReport(
    {
      action: "detail",
      request: detailRequest(),
      raw: projection([], [
        rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
          caption: "<script>alert(1)</script> hello &amp; welcome",
        }),
      ], { action: "detail", entry: rawEntry() }),
    },
    NOW,
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;

  const caption = report.media[0]!.caption ?? "";
  assertEquals(caption.includes("<"), false);
  assertEquals(caption.includes(">"), false);
  assert(caption.includes("hello"));
});

/* -------------------------------------------------------------------------- */
/* The refusals                                                                  */
/* -------------------------------------------------------------------------- */

Deno.test("an unsafe number is refused instead of rounded", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "detail",
          request: detailRequest(),
          raw: projection([], [
            rawMedia("m_target", "2026-10-19T09:00:00+00:00", {
              view_count: 9_007_199_254_740_992,
            }),
          ], { action: "detail", entry: rawEntry() }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a broken payload is a failed read and never an empty report", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "list",
          request: listRequest(),
          raw: projection([rawEntry({ username: "" })], [], {
            entries: [{ username: "" } as unknown as RawEntry],
          }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a projection of another version is refused", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "list",
          request: listRequest(),
          raw: projection([], [], { version: 2 }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a projection that answers another action is refused", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "list",
          request: listRequest(),
          raw: projection([], [], { action: "detail" }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("an entry without both growth periods is refused", () => {
  const entry = rawEntry();
  delete (entry.growth as Record<string, unknown>)["30"];

  assertThrows(
    () =>
      assembleCompetitorReport(
        { action: "list", request: listRequest(), raw: projection([entry]) },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("a media row without a baseline array is refused", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "detail",
          request: detailRequest(),
          raw: projection([], [
            { ig_media_id: "m1" } as unknown as RawMedia,
          ], { action: "detail", entry: rawEntry() }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

Deno.test("an invalid instant is a failed read", () => {
  assertThrows(
    () =>
      assembleCompetitorReport(
        {
          action: "list",
          request: listRequest(),
          raw: projection([rawEntry()], [], {
            as_of: "the day before yesterday",
          }),
        },
        NOW,
        COMPETITOR_REPORT_BASELINE_POLICY,
      ),
    CompetitorReportContractError,
  );
});

/* -------------------------------------------------------------------------- */
/* The captured payload of the real database                                     */
/* -------------------------------------------------------------------------- */

/** The captured projection, read once per suite. */
async function capturedProjection(): Promise<RawReportProjection> {
  return JSON.parse(await Deno.readTextFile(CAPTURED_FIXTURE)) as RawReportProjection;
}

/** The captured projection, assembled at the instant it was read. */
async function assembleCaptured(): Promise<CompetitorReportDetail> {
  const captured = await capturedProjection();
  return assembleCompetitorReport(
    {
      action: "detail",
      request: {
        action: "detail",
        watchlistId: captured.entry!.watchlist_id,
        periodDays: 7,
        limit: 20,
        cursor: null,
      },
      raw: captured,
    },
    new Date(captured.as_of),
    COMPETITOR_REPORT_BASELINE_POLICY,
  ) as CompetitorReportDetail;
}

Deno.test("the captured payload of the real database assembles", async () => {
  const report = await assembleCaptured();

  assertEquals(report.version, 1);
  assertEquals(report.capture_timezone, "Asia/Kuwait");
  assertEquals(report.entry!.watchlist_id, "e2000000-0000-4000-8000-0000000000b1");
  assertEquals(report.entry!.username, "fixture_competitor");
  assertEquals(report.entry!.profile!.followers_count, 1000);
  assertEquals(report.entry!.profile!.source, "official");
  assertEquals(report.media.length, 11);
});

Deno.test("the captured quota matches the seeded rows", async () => {
  const report = await assembleCaptured();

  // The seeded entitlement was five, one entry is tracked and no other entry
  // of this owner exists, so four remain.
  assertEquals(report.quota.max_tracked_competitors, 5);
  assertEquals(report.quota.tracked_active, 1);
  assertEquals(report.quota.remaining, 4);
  assertEquals(report.quota.unlimited, false);
});

Deno.test("the captured growth is the growth the database computed", async () => {
  const report = await assembleCaptured();

  // The baseline sits exactly at the seven day cutoff.
  assertEquals(report.entry!.growth_7d.reason, null);
  assertEquals(report.entry!.growth_7d.absolute, 100);
  assertEquals(report.entry!.growth_7d.baseline_at, "2026-10-13T12:00:00+00:00");
  assertEquals(report.entry!.growth_7d.observed_at, "2026-10-20T12:00:00+00:00");
  assertEquals(report.entry!.growth_7d.interval_days, 7);

  // The thirty day comparison has no comparable baseline in the fixture.
  assertEquals(report.entry!.growth_30d.reason, "missing_baseline");
  assertEquals(report.entry!.growth_30d.absolute, null);
  assertEquals(report.entry!.growth_30d.percent, null);
});

Deno.test("the captured coverage leaves the weekly rate unknown", async () => {
  const report = await assembleCaptured();

  // The provider ordering is not a verified contract yet, so the week is
  // unknown even though two posts were observed inside it.
  assertEquals(report.entry!.weekly.coverage, "unknown");
  assertEquals(report.entry!.weekly.reason, "ordering_unverified");
  assertEquals(report.entry!.weekly.posts_per_week, null);
  assertEquals(report.entry!.weekly.observed_count, 2);
});

Deno.test("the captured media are scored by the canonical algorithm", async () => {
  const report = await assembleCaptured();

  const target = report.media.find((item) => item.ig_media_id === "fixture_reel_target");
  assert(target !== undefined);
  assertEquals(target.outlier.metric_basis, "public_views");
  assertEquals(target.outlier.baselineSize, 8);
  // The eight earlier reels run from 1000 to 1070, so the median is 1035.
  assertEquals(target.outlier.baselineMedian, 1035);
  assertEquals(target.outlier.score, 5000 / 1035);
  assertEquals(target.outlier.label, "outlier");
  assertEquals(target.outlier.reason, null);
});

Deno.test("the captured freshness comes from the committed coverage and the job", async () => {
  const report = await assembleCaptured();

  assertEquals(report.entry!.freshness.job_status, "partial");
  assertEquals(report.entry!.freshness.reason_code, "provider_throttled");
  assertEquals(report.entry!.freshness.last_capture_at, "2026-10-29T00:57:39.702828+00:00");
  assert(report.entry!.freshness.last_partial_at !== null);
  assert(report.entry!.freshness.last_full_success_at !== null);
});
