/**
 * The weekly inventory of the competitor tracking report.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The posts-per-week number of one entry, and the proof - or the refusal
 *   of the proof - that the seven-day window was fully observed.
 *
 * WHY THE RATE IS USUALLY UNAVAILABLE
 *
 *   Spec §6 ("Weekly inventory") and the parent plan's clarification 9 are
 *   binding: a successful capture is NOT evidence of a complete week. The
 *   rate is published only when the committed coverage EVIDENCE proves the
 *   window:
 *
 *     * the provider's ordering is a verified contract (`ordering_verified`);
 *     * the capture walked the whole feed (`exhausted`, no `gap_reason`);
 *     * the capture was not cut short (`truncated` is false);
 *     * the oldest returned item reaches the START of the window, so nothing
 *       older than the window is hiding inside it.
 *
 *   Until the provider ordering contract exists, `ordering_verified` is
 *   always false, so the coverage is UNKNOWN and the rate is null. That is
 *   the truthful answer, and it is not a placeholder: the observed count is
 *   still published, and the reason says exactly which piece of evidence is
 *   missing.
 *
 *   A window whose coverage is PARTIAL keeps its observed count and refuses
 *   the rate. The count is a fact about what was seen; the rate is a claim
 *   about a whole week.
 *
 * THE INTERVAL
 *
 *   The interval is anchored to the latest committed INVENTORY observation -
 *   the newest committed coverage row - and never to the browser's clock.
 *   A client that reads the report tomorrow sees the same window it saw
 *   today, and the window it sees is the one the stored evidence describes.
 *
 *   When there is no coverage row at all (a legacy entry that predates the
 *   coverage ledger), the newest captured media row anchors the window
 *   instead. SQL derives that fallback from the whole stored inventory,
 *   independently of the media page being displayed.
 *
 * REPEATED DAILY SNAPSHOTS ARE NOT NEW POSTS
 *
 *   The count is of DISTINCT `ig_media_id` values, so a post captured on
 *   three days is one observed post.
 */

import {
  CompetitorReportContractError,
  isRecord,
  parseInstant,
  readCalendarDate,
  readCount,
  readOptionalFlag,
  requireText,
  type CompetitorReportWeekly,
  type CompetitorReportWeeklyCoverage,
  type RawCoverageRow,
} from "./contracts.ts";

/** The window the rate describes, in days. */
export const COMPETITOR_REPORT_WEEKLY_WINDOW_DAYS = 7;

/** The milliseconds of one day. */
const MILLISECONDS_PER_DAY = 86_400_000;

/**
 * The closed set of weekly reasons.
 *
 * They are stable codes the UI translates; they are never prose.
 */
export type WeeklyInventoryReason =
  | "coverage_missing"
  | "ordering_unverified"
  | "coverage_truncated"
  | "capture_gap"
  | "capture_not_exhausted"
  | "coverage_window_short";

export type WeeklyInventoryInput = {
  /** The committed whole-window projection, independent of display pages. */
  readonly summary: unknown;
  /** The committed capture coverage of the entry, newest day first. */
  readonly coverage: readonly RawCoverageRow[];
};

/**
 * Assembles the weekly posting projection of one entry.
 *
 * @throws CompetitorReportContractError when the evidence is malformed.
 */
export function assembleWeeklyInventory(input: WeeklyInventoryInput): CompetitorReportWeekly {
  if (!isRecord(input)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the weekly input must be an object",
    );
  }
  if (!Array.isArray(input.coverage)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "weekly.coverage must be an array",
    );
  }

  const coverage = input.coverage.map((row, index) => readCoverageRow(row, `coverage[${index}]`));
  const anchorRow = newestCoverageRow(coverage);
  const summary = readWeeklySummary(input.summary);
  const anchorMs = summary.end;
  const coverageAnchor = resolveAnchor(anchorRow);
  if (coverageAnchor !== null && coverageAnchor !== anchorMs) {
    throw new CompetitorReportContractError("REPORT_UNAVAILABLE", "weekly summary does not match its committed coverage");
  }

  if (anchorMs === null) {
    // There is no committed inventory observation at all: there is no window
    // and no observed post inside it.
    return {
      observed_count: 0,
      posts_per_week: null,
      interval_start: null,
      interval_end: null,
      coverage: "unknown",
      reason: "coverage_missing",
    };
  }

  const intervalEnd = anchorMs;
  const intervalStart = anchorMs - COMPETITOR_REPORT_WEEKLY_WINDOW_DAYS * MILLISECONDS_PER_DAY;

  const observedCount = summary.count;

  const verdict = classifyCoverage(anchorRow, intervalStart);

  return {
    observed_count: observedCount,
    posts_per_week: verdict.coverage === "complete"
      ? observedCount
      : null,
    interval_start: new Date(intervalStart).toISOString(),
    interval_end: new Date(intervalEnd).toISOString(),
    coverage: verdict.coverage,
    reason: verdict.reason,
  };
}

/* -------------------------------------------------------------------------- */
/* The evidence                                                                  */
/* -------------------------------------------------------------------------- */

type CoverageVerdict = {
  readonly coverage: CompetitorReportWeeklyCoverage;
  readonly reason: WeeklyInventoryReason | null;
};

/**
 * Classifies the coverage of the anchor capture.
 *
 * The order matters and it is the order of the evidence: without a verified
 * provider ordering the window cannot be established in EITHER direction, so
 * it stays unknown even when the capture also reports a gap. A verified
 * ordering with a bounded capture is a partial window - a lower bound we
 * can name.
 */
function classifyCoverage(
  anchor: RawCoverageRow | null,
  intervalStartMs: number,
): CoverageVerdict {
  if (anchor === null) {
    return { coverage: "unknown", reason: "coverage_missing" };
  }

  if (anchor.ordering_verified !== true) {
    return { coverage: "unknown", reason: "ordering_unverified" };
  }

  if (anchor.truncated === true) {
    return { coverage: "partial", reason: "coverage_truncated" };
  }

  if (anchor.gap_reason !== null) {
    return { coverage: "partial", reason: "capture_gap" };
  }

  if (anchor.exhausted !== true) {
    return { coverage: "partial", reason: "capture_not_exhausted" };
  }

  if (anchor.oldest_returned_at === null) {
    // A capture that returned nothing cannot prove that the window is
    // empty: the oldest returned item is unknown.
    return { coverage: "partial", reason: "coverage_window_short" };
  }

  const oldestMs = parseInstant(
    anchor.oldest_returned_at,
    "oldest_returned_at",
    "coverage",
  );
  if (oldestMs > intervalStartMs) {
    // The oldest returned item is INSIDE the window, so an older post may
    // exist that this capture never returned.
    return { coverage: "partial", reason: "coverage_window_short" };
  }

  return { coverage: "complete", reason: null };
}

/**
 * The newest committed coverage row.
 *
 * The rows arrive newest day first; the sort is repeated here so the anchor
 * does not depend on the order the reader happened to return them in.
 */
function newestCoverageRow(rows: readonly RawCoverageRow[]): RawCoverageRow | null {
  let newest: RawCoverageRow | null = null;
  for (const row of rows) {
    if (newest === null) {
      newest = row;
      continue;
    }
    if (row.captured_on > newest.captured_on) {
      newest = row;
      continue;
    }
    if (row.captured_on < newest.captured_on) continue;
    const rowMs = parseInstant(row.captured_at, "captured_at", "coverage");
    const newestMs = parseInstant(newest.captured_at, "captured_at", "coverage");
    if (rowMs > newestMs) newest = row;
  }
  return newest;
}

/**
 * The instant the displayed window ends at.
 *
 * The committed coverage wins: it is the inventory observation and it does
 * not depend on which page of media was read. The newest captured media row
 * is the fallback for an entry that has no coverage ledger at all.
 */
function resolveAnchor(
  anchor: RawCoverageRow | null,
): number | null {
  if (anchor !== null) {
    const endedAt = anchor.capture_ended_at ?? anchor.captured_at;
    return parseInstant(endedAt, "captured_at", "coverage");
  }

  return null;
}

/**
 * The owner-scoped SQL reader counted distinct observed IDs across the
 * whole window. An absent or inconsistent aggregate is a failed read;
 * the displayed media page is never a substitute for that measurement.
 */
function readWeeklySummary(raw: unknown): { count: number; end: number | null } {
  if (!isRecord(raw) || typeof raw.observed_count !== "number" || !Number.isSafeInteger(raw.observed_count) || raw.observed_count < 0) {
    throw new CompetitorReportContractError("REPORT_UNAVAILABLE", "weekly inventory requires a safe committed count");
  }
  if (raw.interval_start === null && raw.interval_end === null && raw.observed_count === 0) return { count: 0, end: null };
  const start = parseInstant(requireText(raw.interval_start, "interval_start", "weekly"), "interval_start", "weekly");
  const end = parseInstant(requireText(raw.interval_end, "interval_end", "weekly"), "interval_end", "weekly");
  if (end - start !== COMPETITOR_REPORT_WEEKLY_WINDOW_DAYS * MILLISECONDS_PER_DAY) {
    throw new CompetitorReportContractError("REPORT_UNAVAILABLE", "weekly inventory requires an exact seven-day interval");
  }
  return { count: raw.observed_count, end };
}

/* -------------------------------------------------------------------------- */
/* The raw reader                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads one coverage row.
 *
 * The booleans are the EVIDENCE of a complete window, so a non-boolean is
 * refused rather than read as false: a flag that silently turns off is how a
 * partial or truncated capture stops being reported.
 */
export function readCoverageRow(raw: unknown, context: string): RawCoverageRow {
  if (!isRecord(raw)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} must be an object`,
    );
  }
  const capturedAt = requireText(raw.captured_at, "captured_at", context);
  parseInstant(capturedAt, "captured_at", context);

  const captureStartedAt = typeof raw.capture_started_at === "string"
    ? raw.capture_started_at
    : null;
  if (captureStartedAt !== null) parseInstant(captureStartedAt, "capture_started_at", context);

  const captureEndedAt = typeof raw.capture_ended_at === "string"
    ? raw.capture_ended_at
    : null;
  if (captureEndedAt !== null) parseInstant(captureEndedAt, "capture_ended_at", context);

  const oldestReturnedAt = typeof raw.oldest_returned_at === "string"
    ? raw.oldest_returned_at
    : null;
  if (oldestReturnedAt !== null) parseInstant(oldestReturnedAt, "oldest_returned_at", context);

  return {
    captured_on: readCalendarDate(raw.captured_on, "captured_on", context),
    captured_at: capturedAt,
    source: typeof raw.source === "string" ? raw.source : null,
    job_generation: readCount(raw.job_generation, "job_generation", context),
    capture_started_at: captureStartedAt,
    capture_ended_at: captureEndedAt,
    oldest_returned_at: oldestReturnedAt,
    ordering_verified: readOptionalFlag(raw.ordering_verified, "ordering_verified", context),
    cursor_present: readOptionalFlag(raw.cursor_present, "cursor_present", context),
    exhausted: readOptionalFlag(raw.exhausted, "exhausted", context),
    truncated: readOptionalFlag(raw.truncated, "truncated", context),
    gap_reason: typeof raw.gap_reason === "string" ? raw.gap_reason : null,
  };
}
