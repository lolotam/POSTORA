/**
 * The pure assembler of the competitor tracking report.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The translation of the RAW database projection into the public DTO v1 of
 *   spec §5. It performs no I/O: no fetch, no Supabase client, no
 *   filesystem, no clock of its own. The instant is injected and every row
 *   arrives as an argument, so the whole report is reproducible from its
 *   inputs.
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *   - NULL IS UNAVAILABLE, NEVER ZERO. A missing measurement stays null. A
 *     refused comparison produces null outputs and an explicit reason.
 *   - NO SECOND OUTLIER ALGORITHM. The score comes from
 *     `_shared/outlierScore.ts`, which is imported and called, never copied.
 *     The cohort (same source, same metric basis, same format) is the one the
 *     DATABASE proved; this module hands those candidates to the canonical
 *     scorer and lets it decide the baseline.
 *   - THE BASELINE IS INDEPENDENT OF THE DISPLAY PERIOD. The score of an item
 *     is the same whichever period was requested: nothing here reads the
 *     period while scoring.
 *   - THE POLICY IS THE SERVER'S. The baseline staleness tolerance comes
 *     from the injected policy, never from the request or the payload.
 *   - SAFE PROJECTIONS. A URL is projected only when it is an http(s) URL
 *     without credentials; a caption is projected as plain text, never as
 *     markup.
 *   - A MALFORMED ROW IS A FAILED READ. The assembler refuses what it cannot
 *     trust; it never repairs it and never returns an empty report in place
 *     of a broken one.
 */

import {
  computeOutlierScores,
  type OutlierFormat,
  type OutlierInput,
  type OutlierResult,
} from "../_shared/outlierScore.ts";

import {
  COMPETITOR_REPORT_CAPTURE_TIMEZONE,
  COMPETITOR_REPORT_SCHEMA_VERSION,
  CompetitorReportContractError,
  isRecord,
  optionalText,
  parseInstant,
  readCalendarDate,
  readCount,
  readFlag,
  readOptionalInstant,
  readPlainCaption,
  readSafeUrl,
  readSource,
  requireText,
  type CompetitorReport,
  type CompetitorReportDetail,
  type CompetitorReportEntry,
  type CompetitorReportFreshness,
  type CompetitorReportList,
  type CompetitorReportMedia,
  type CompetitorReportMetricBasis,
  type CompetitorReportOutlier,
  type CompetitorReportProfileObservation,
  type CompetitorReportQuota,
  type CompetitorReportRequest,
  type CompetitorReportSource,
  type RawBaselineCandidate,
  type RawEntry,
  type RawMedia,
  type RawReportProjection,
} from "./contracts.ts";

import { mapGrowth, type BaselinePolicy } from "./growth.ts";
import { assembleWeeklyInventory } from "./weeklyInventory.ts";

/* -------------------------------------------------------------------------- */
/* The canonical scoring contract                                                */
/* -------------------------------------------------------------------------- */

/**
 * The canonical scoring contract of the report.
 *
 * These are the plan's numbers (spec §6): a 48 hour maturity window, a
 * minimum baseline of six and a baseline cap of twelve. They are passed
 * EXPLICITLY rather than left to the defaults, so the contract of this
 * report is visible here and cannot change silently with the shared module.
 */
const COMPETITOR_REPORT_OUTLIER_OPTIONS = {
  baselineSize: 12,
  minBaseline: 6,
  minAgeHours: 48,
} as const;

/** The input of the assembler. */
export type CompetitorReportAssemblyInput = {
  readonly action: "list" | "detail";
  readonly request: CompetitorReportRequest;
  readonly raw: RawReportProjection;
};

/* -------------------------------------------------------------------------- */
/* The assembler                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the competitor tracking report.
 *
 * @param input The raw projection and the request that produced it.
 * @param now The instant the cohorts are scored at. It is injected so the
 *   result is reproducible; nothing here reads the clock itself.
 * @param baselinePolicy The approved baseline staleness policy, or null when
 *   none is configured.
 * @throws CompetitorReportContractError for a structurally broken input.
 */
export function assembleCompetitorReport(
  input: CompetitorReportAssemblyInput,
  now: Date,
  baselinePolicy: BaselinePolicy | null,
): CompetitorReport {
  if (!isRecord(input)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the report input must be an object",
    );
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "now must be a valid Date",
    );
  }
  if (input.action !== "list" && input.action !== "detail") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the report action must be list or detail",
    );
  }

  const raw = input.raw;
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the raw projection must be an object",
    );
  }
  if (raw.action !== input.action) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the raw projection answers another action",
    );
  }
  if (raw.version !== COMPETITOR_REPORT_SCHEMA_VERSION) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the raw projection has another version",
    );
  }

  const asOf = requireText(raw.as_of, "as_of", "projection");
  parseInstant(asOf, "as_of", "projection");
  const captureTimezone = requireText(raw.capture_timezone, "capture_timezone", "projection");
  if (captureTimezone !== COMPETITOR_REPORT_CAPTURE_TIMEZONE) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the raw projection carries another capture timezone",
    );
  }
  const quota = readQuota(raw.quota);
  const nextCursor = readCursor(raw.next_cursor);

  const media = raw.media.map((row, index) => readMediaRow(row, `media[${index}]`));

  const isDetail = input.action === "detail";

  const envelope = {
    version: COMPETITOR_REPORT_SCHEMA_VERSION,
    as_of: asOf,
    capture_timezone: COMPETITOR_REPORT_CAPTURE_TIMEZONE,
    quota,
    next_cursor: nextCursor,
  } as const;

  let report: CompetitorReport;
  if (isDetail) {
    const entry = raw.entry === null
      ? null
      : assembleEntry(raw.entry, "entry", media, true, now, baselinePolicy);
    const detail: CompetitorReportDetail = {
      ...envelope,
      entry,
      media: media.map((row) => assembleMedia(row, now)),
    };
    report = detail;
  } else {
    const entries = raw.entries.map((row, index) =>
      assembleEntry(row, `entries[${index}]`, media, false, now, baselinePolicy)
    );
    const list: CompetitorReportList = { ...envelope, entries };
    report = list;
  }

  assertNoNonFiniteNumbers(report, "report");
  return report;
}

/* -------------------------------------------------------------------------- */
/* The envelope                                                                  */
/* -------------------------------------------------------------------------- */

function readQuota(raw: unknown): CompetitorReportQuota {
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "quota must be an object",
    );
  }
  const unlimited = raw.unlimited;
  if (typeof unlimited !== "boolean") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "quota.unlimited must be a boolean",
    );
  }
  const trackedActive = readCount(raw.tracked_active, "tracked_active", "quota");
  if (trackedActive === null) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "quota.tracked_active must be a number",
    );
  }
  return {
    max_tracked_competitors: readCount(
      raw.max_tracked_competitors,
      "max_tracked_competitors",
      "quota",
    ),
    unlimited,
    tracked_active: trackedActive,
    remaining: readCount(raw.remaining, "remaining", "quota"),
  };
}

/**
 * The opaque cursor.
 *
 * It is passed through VERBATIM: the database produced it with the exact
 * timestamp precision of the rows, and re-encoding it here would round it.
 */
function readCursor(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "next_cursor must be a string",
    );
  }
  if (raw.length > 2048) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "next_cursor is longer than the cursor bound",
    );
  }
  return raw;
}

/* -------------------------------------------------------------------------- */
/* The entry                                                                     */
/* -------------------------------------------------------------------------- */

function assembleEntry(
  raw: RawEntry,
  context: string,
  media: readonly RawMedia[],
  inventoryIncluded: boolean,
  now: Date,
  baselinePolicy: BaselinePolicy | null,
): CompetitorReportEntry {
  const coverage = Array.isArray(raw.coverage) ? raw.coverage : [];
  const growth = isRecord(raw.growth) ? raw.growth : {};
  const profile = assembleProfile(raw.profile, context);

  return {
    watchlist_id: requireText(raw.watchlist_id, "watchlist_id", context),
    username: requireText(raw.username, "username", context),
    label: optionalText(raw.label),
    is_active: readFlag(raw.is_active, "is_active", context),
    removed_at: readOptionalInstant(raw.removed_at, "removed_at", context),
    status: requireText(raw.status, "status", context),
    last_error_code: optionalText(raw.last_error_code),
    next_retry_at: readOptionalInstant(raw.next_retry_at, "next_retry_at", context),
    cleanup_eligible_at: readOptionalInstant(
      raw.cleanup_eligible_at,
      "cleanup_eligible_at",
      context,
    ),
    profile,
    freshness: assembleFreshness(raw, profile, coverage, context),
    growth_7d: mapGrowth(growth["7"], 7, baselinePolicy),
    growth_30d: mapGrowth(growth["30"], 30, baselinePolicy),
    weekly: assembleWeeklyInventory({
      media: inventoryIncluded ? media : [],
      coverage,
      inventoryIncluded,
    }),
  };
}

function assembleProfile(
  raw: unknown,
  context: string,
): CompetitorReportProfileObservation | null {
  if (raw === undefined || raw === null) return null;
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.profile must be an object`,
    );
  }
  const capturedAt = requireText(raw.captured_at, "captured_at", `${context}.profile`);
  parseInstant(capturedAt, "captured_at", `${context}.profile`);
  return {
    followers_count: readCount(raw.followers_count, "followers_count", `${context}.profile`),
    media_count: readCount(raw.media_count, "media_count", `${context}.profile`),
    captured_at: capturedAt,
    captured_on: readCalendarDate(raw.captured_on, "captured_on", `${context}.profile`),
    source: readSource(raw.source, "source", `${context}.profile`),
  };
}

/**
 * The committed capture state of one entry.
 *
 * `last_capture_at` is the newest committed capture instant the stored
 * evidence carries: the newest coverage row, or - for an entry that predates
 * the coverage ledger - the newest successful profile observation. The
 * watchlist's own `last_synced_at` is NOT used: it is the publication of a
 * capture, not the proof of a complete inventory.
 */
function assembleFreshness(
  raw: RawEntry,
  profile: CompetitorReportProfileObservation | null,
  coverage: readonly unknown[],
  context: string,
): CompetitorReportFreshness {
  let lastCaptureAt: string | null = null;

  for (const row of coverage) {
    if (!isRecord(row)) continue;
    const capturedAt = typeof row.captured_at === "string" ? row.captured_at : null;
    if (capturedAt === null) continue;
    if (lastCaptureAt === null || capturedAt > lastCaptureAt) lastCaptureAt = capturedAt;
  }

  if (lastCaptureAt === null && profile !== null) {
    lastCaptureAt = profile.captured_at;
  }

  const job = raw.job;
  return {
    last_capture_at: lastCaptureAt,
    last_full_success_at: job === null
      ? null
      : readOptionalInstant(job.last_success_at, "last_success_at", `${context}.job`),
    last_partial_at: job === null
      ? null
      : readOptionalInstant(job.last_partial_at, "last_partial_at", `${context}.job`),
    job_status: job === null || job.status === null ? null : requireText(
      job.status,
      "status",
      `${context}.job`,
    ),
    reason_code: job === null ? null : optionalText(job.last_reason_code),
  };
}

/* -------------------------------------------------------------------------- */
/* The media                                                                     */
/* -------------------------------------------------------------------------- */

function readMediaRow(raw: unknown, context: string): RawMedia {
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} must be an object`,
    );
  }
  const publishedAt = requireText(raw.published_at, "published_at", context);
  parseInstant(publishedAt, "published_at", context);
  const capturedAt = requireText(raw.captured_at, "captured_at", context);
  parseInstant(capturedAt, "captured_at", context);

  const baseline = raw.baseline;
  if (!Array.isArray(baseline)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.baseline must be an array`,
    );
  }
  return {
    ig_media_id: requireText(raw.ig_media_id, "ig_media_id", context),
    published_at: publishedAt,
    captured_at: capturedAt,
    media_product_type: optionalText(raw.media_product_type),
    media_type: optionalText(raw.media_type),
    thumbnail_url: typeof raw.thumbnail_url === "string" ? raw.thumbnail_url : null,
    permalink: typeof raw.permalink === "string" ? raw.permalink : null,
    caption: typeof raw.caption === "string" ? raw.caption : null,
    like_count: readCount(raw.like_count, "like_count", context),
    comments_count: readCount(raw.comments_count, "comments_count", context),
    view_count: readCount(raw.view_count, "view_count", context),
    source: typeof raw.source === "string" ? raw.source : null,
    metric_basis: typeof raw.metric_basis === "string" ? raw.metric_basis : null,
    mature: readFlag(raw.mature, "mature", context),
    baseline: baseline.map((candidate, index) =>
      readBaselineCandidate(candidate, `${context}.baseline[${index}]`)
    ),
    baseline_incomplete: readFlag(raw.baseline_incomplete, "baseline_incomplete", context),
  };
}

function readBaselineCandidate(raw: unknown, context: string): RawBaselineCandidate {
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} must be an object`,
    );
  }
  const publishedAt = requireText(raw.published_at, "published_at", context);
  parseInstant(publishedAt, "published_at", context);
  const capturedAt = requireText(raw.captured_at, "captured_at", context);
  parseInstant(capturedAt, "captured_at", context);

  return {
    ig_media_id: requireText(raw.ig_media_id, "ig_media_id", context),
    published_at: publishedAt,
    captured_at: capturedAt,
    source: typeof raw.source === "string" ? raw.source : null,
    metric_basis: typeof raw.metric_basis === "string" ? raw.metric_basis : null,
    value: readCount(raw.value, "value", context),
  };
}

/**
 * Assembles one media item with its canonical outlier verdict.
 *
 * The cohort is the one the DATABASE proved: the same source, the same
 * metric basis, the same format, strictly earlier, mature and carrying a
 * usable measurement. Those candidates are handed to the canonical scorer,
 * which selects the baseline and computes the score. Nothing here computes
 * a ratio.
 */
function assembleMedia(raw: RawMedia, now: Date): CompetitorReportMedia {
  const basis = readMetricBasis(raw.metric_basis);
  const source = readSource(raw.source, "source", "media");

  const outlier = scoreMedia(raw, basis, source, now);

  return {
    ig_media_id: raw.ig_media_id,
    published_at: raw.published_at,
    captured_at: raw.captured_at,
    media_product_type: raw.media_product_type,
    media_type: raw.media_type,
    thumbnail_url: readSafeUrl(raw.thumbnail_url, "thumbnail_url", "media"),
    permalink: readSafeUrl(raw.permalink, "permalink", "media"),
    caption: readPlainCaption(raw.caption, "caption", "media"),
    like_count: raw.like_count,
    comments_count: raw.comments_count,
    view_count: raw.view_count,
    source,
    outlier,
  };
}

/**
 * The metric basis of one media item.
 *
 * The database decided it: a reel is measured by its public views, a feed or
 * a carousel album by its public interactions, and an unknown, story or ad
 * product type has no basis at all. A `VIDEO` media type is NOT a reel.
 */
function readMetricBasis(raw: string | null): CompetitorReportMetricBasis | null {
  if (raw === null) return null;
  if (raw === "public_views" || raw === "public_interactions") return raw;
  throw new CompetitorReportContractError(
    "REPORT_UNAVAILABLE",
    "media.metric_basis is not a known metric basis",
  );
}

/** The format of the canonical scorer, derived from the metric basis. */
function formatOf(basis: CompetitorReportMetricBasis | null): OutlierFormat | null {
  if (basis === "public_views") return "reel";
  if (basis === "public_interactions") return "non_reel";
  return null;
}

/**
 * The measured value of one media item.
 *
 * A reel is measured by its public views. A feed is measured by its public
 * interactions - and BOTH the likes and the comments must exist: a missing
 * one is not a zero, so the item has no value at all.
 */
function metricValueOf(raw: RawMedia, basis: CompetitorReportMetricBasis | null): number | null {
  if (basis === "public_views") return raw.view_count;
  if (basis === "public_interactions") {
    if (raw.like_count === null || raw.comments_count === null) return null;
    const sum = raw.like_count + raw.comments_count;
    if (!Number.isSafeInteger(sum)) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        "media interactions are not a safe integer",
      );
    }
    return sum;
  }
  return null;
}

function scoreMedia(
  raw: RawMedia,
  basis: CompetitorReportMetricBasis | null,
  source: CompetitorReportSource,
  now: Date,
): CompetitorReportOutlier {
  const format = formatOf(basis);
  const value = metricValueOf(raw, basis);

  // An item with no metric basis has no score at all. It is not a reel by
  // assumption and it is not a zero.
  if (format === null) {
    return neutralOutlier(raw.ig_media_id, basis, source, "no_metric_basis");
  }

  // A capped scan that could not prove the eligibility of the baseline
  // carries no score. A short baseline is never presented as a complete one.
  if (raw.baseline_incomplete) {
    return neutralOutlier(raw.ig_media_id, basis, source, "baseline_incomplete");
  }

  const inputs: OutlierInput[] = [
    {
      id: raw.ig_media_id,
      format,
      publishedAt: raw.published_at,
      value,
    },
  ];

  for (const candidate of raw.baseline) {
    const candidateFormat = formatOf(readMetricBasis(candidate.metric_basis));
    if (candidateFormat !== format) continue;
    inputs.push({
      id: candidate.ig_media_id,
      format: candidateFormat,
      publishedAt: candidate.published_at,
      value: candidate.value,
    });
  }

  const results: OutlierResult[] = computeOutlierScores(
    inputs,
    now,
    COMPETITOR_REPORT_OUTLIER_OPTIONS,
  );

  const result = results.find((entry) => entry.id === raw.ig_media_id);
  if (!result) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the canonical scorer did not answer for the scored item",
    );
  }

  return {
    id: result.id,
    score: result.score,
    label: result.label,
    baselineMedian: result.baselineMedian,
    baselineSize: result.baselineSize,
    metric_basis: basis,
    source,
    reason: reasonForLabel(result.label),
  };
}

function neutralOutlier(
  id: string,
  basis: CompetitorReportMetricBasis | null,
  source: CompetitorReportSource,
  reason: string,
): CompetitorReportOutlier {
  return {
    id,
    score: null,
    label: "no_data",
    baselineMedian: null,
    baselineSize: 0,
    metric_basis: basis,
    source,
    reason,
  };
}

/**
 * The reason of a neutral label.
 *
 * A real classification has no reason: the label IS the verdict. A neutral
 * state names why there is no verdict.
 */
function reasonForLabel(label: OutlierResult["label"]): string | null {
  switch (label) {
    case "outlier":
    case "above":
    case "normal":
    case "below":
      return null;
    default:
      return label;
  }
}

/* -------------------------------------------------------------------------- */
/* The final guard                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The report is serialised to JSON and shipped to a browser. A NaN or an
 * Infinity would be silently rewritten to null on the way out, so the
 * assembler refuses to produce one instead of letting it change meaning
 * after the fact.
 */
function assertNoNonFiniteNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        `${path} is not a finite number`,
      );
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) => assertNoNonFiniteNumbers(entry, `${path}[${index}]`));
    return;
  }
  if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      assertNoNonFiniteNumbers(entry, `${path}.${key}`);
    }
  }
}
