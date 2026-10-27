/**
 * Pure assembler for the owner Instagram insights report.
 *
 * It takes the rows a repository read and produces the frozen owner-report
 * DTO (schema version 1, `contracts.ts`). It performs no I/O: no fetch, no
 * Supabase client, no filesystem, no clock of its own. The instant is
 * injected and every row arrives as an argument, so the whole report is
 * reproducible from its inputs (plan section 5.4).
 *
 * The rules this module owns:
 *
 *   - LATEST CAPTURE PER MEDIA, BEFORE ANY FILTER. The newest completed
 *     capture of a media is the one that is scored and displayed. A later
 *     failed attempt never erases the metrics an earlier capture recorded.
 *   - BASELINES ARE INDEPENDENT OF THE DISPLAY PERIOD. The cohort is built
 *     from the merged inventory - the display rows and the period
 *     independent baseline history alike - so a 7 day window and a 90 day
 *     window score the same item identically. The baseline is the strictly
 *     earlier, mature items of the same account, source, metric basis and
 *     format.
 *   - UNITS ARE NEVER MIXED. Reels are scored on views. Non-reels prefer
 *     reach and fall back to an explicitly labelled interactions cohort.
 *     Reach and interactions never share a median, and the two formats never
 *     share a baseline.
 *   - NULL IS UNAVAILABLE, NEVER ZERO. A missing, non-finite or negative
 *     metric is unavailable. It is never coerced into a measurement, and
 *     the report never serialises NaN or Infinity.
 *   - NO PROVIDER CALLS, NO CREDENTIALS, NO RAW ERRORS. The report carries
 *     typed reason codes and nothing else.
 *
 * The scoring itself is NOT implemented here: `_shared/outlierScore.ts` owns
 * the algorithm and this module calls it. There is no second copy.
 */

import {
  computeOutlierScores,
  type OutlierFormat,
  type OutlierInput,
} from "../_shared/outlierScore.ts";
import {
  MILLISECONDS_PER_DAY,
  OWNER_REPORT_LAG_NOTE,
  OWNER_REPORT_SCHEMA_VERSION,
  OwnerReportContractError,
  addUtcDays,
  isCalendarDate,
  isRecord,
  optionalText,
  parseInstant,
  parseOwnerReportRequest,
  readMetric,
  requireText,
  utcDateString,
  type OwnerReport,
  type OwnerReportAssemblyInput,
  type OwnerReportCompleteness,
  type OwnerReportCompletenessInput,
  type OwnerReportCoverage,
  type OwnerReportCursor,
  type OwnerReportDailyRow,
  type OwnerReportEngagementRate,
  type OwnerReportFreshness,
  type OwnerReportFreshnessInput,
  type OwnerReportMediaCoverage,
  type OwnerReportMediaItem,
  type OwnerReportMetricBasis,
  type OwnerReportOutlier,
  type OwnerReportProfileObservation,
  type OwnerReportReasonCode,
  type OwnerReportRowStatus,
  type OwnerReportScope,
  type OwnerReportSyncStatus,
} from "./contracts.ts";

/* -------------------------------------------------------------------------- */
/* Row normalisation                                                            */
/* -------------------------------------------------------------------------- */

type NormalizedMediaRow = {
  id: string;
  mediaId: string;
  postId: string | null;
  publishedAt: string;
  publishedMs: number;
  capturedAt: string;
  capturedMs: number;
  capturedOn: string;
  captureTimezone: string;
  mediaProductType: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  status: OwnerReportRowStatus;
  views: number | null;
  reach: number | null;
  likes: number | null;
  comments: number | null;
  saved: number | null;
  shares: number | null;
  totalInteractions: number | null;
  follows: number | null;
  profileVisits: number | null;
  replies: number | null;
  igReelsAvgWatchTimeMs: number | null;
};

type NormalizedDailyRow = {
  id: string;
  metricDate: string;
  providerDate: string;
  periodStart: string | null;
  periodEnd: string | null;
  providerTimezone: string | null;
  status: OwnerReportRowStatus;
  capturedAt: string;
  capturedMs: number;
  reach: number | null;
  views: number | null;
  accountsEngaged: number | null;
  totalInteractions: number | null;
  likes: number | null;
  comments: number | null;
  saves: number | null;
  shares: number | null;
  follows: number | null;
  unfollows: number | null;
};

type NormalizedProfileRow = {
  id: string;
  observedAt: string;
  observedMs: number;
  observedOn: string;
  captureTimezone: string;
  status: OwnerReportRowStatus;
  followersCount: number | null;
  mediaCount: number | null;
};

function isRowStatus(value: unknown): value is OwnerReportRowStatus {
  return value === "pending" || value === "ok" || value === "unavailable" || value === "error";
}

function isSyncStatus(value: unknown): value is OwnerReportSyncStatus {
  return value === "ok" || value === "partial" || value === "error" || value === "never";
}

function isCoverage(value: unknown): value is OwnerReportCoverage {
  return value === "complete" || value === "partial" || value === "unknown";
}

function isReasonCode(value: unknown): value is OwnerReportReasonCode {
  return value === "ok" ||
    value === "never_synced" ||
    value === "scope_missing" ||
    value === "reauth_required" ||
    value === "throttled" ||
    value === "usage_limit_reached" ||
    value === "provider_unavailable" ||
    value === "provider_error" ||
    value === "network_error" ||
    value === "write_failed" ||
    value === "inventory_truncated" ||
    value === "baseline_history_incomplete" ||
    value === "unknown";
}

/**
 * A row that names another owner or another account is refused, not
 * filtered out: a mis-scoped read is a defect that must be visible, and
 * silently dropping the foreign rows would hide it.
 */
function assertRowScope(
  row: Record<string, unknown>,
  scope: OwnerReportScope,
  context: string,
): void {
  const ownerId = optionalText(row.ownerId);
  if (ownerId !== null && ownerId !== scope.ownerId) {
    throw new OwnerReportContractError(
      "ACCOUNT_MISMATCH",
      `${context} belongs to a different owner`,
    );
  }
  const accountId = optionalText(row.socialAccountId);
  if (accountId !== null && accountId !== scope.socialAccountId) {
    throw new OwnerReportContractError(
      "ACCOUNT_MISMATCH",
      `${context} belongs to a different social account`,
    );
  }
}

function readInstant(
  value: unknown,
  field: string,
  context: string,
): { text: string; ms: number } {
  if (typeof value !== "string") {
    throw new OwnerReportContractError(
      "INVALID_ROW",
      `${context}.${field} must be an ISO-8601 instant`,
    );
  }
  const raw = value.trim();
  const ms = parseInstant(raw, field, context);
  // Normalize zones and redundant fractional zeros without rounding database
  // microseconds (or any finer precision accepted by the existing grammar).
  const fraction = (/\.(\d+)/.exec(raw)?.[1] ?? "").replace(/0+$/, "").padEnd(3, "0");
  const text = new Date(ms).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
  return { text, ms };
}

/** Date supplies milliseconds; decimal comparison preserves finer instants. */
function compareInstants(aMs: number, aText: string, bMs: number, bText: string): number {
  if (aMs !== bMs) return aMs - bMs;
  const a = /\.(\d+)/.exec(aText)?.[1] ?? "";
  const b = /\.(\d+)/.exec(bText)?.[1] ?? "";
  const length = Math.max(a.length, b.length);
  const left = a.padEnd(length, "0");
  const right = b.padEnd(length, "0");
  return left < right ? -1 : left > right ? 1 : 0;
}

function readOptionalInstant(value: unknown, field: string, context: string): string | null {
  if (value === undefined || value === null) return null;
  return readInstant(value, field, context).text;
}

function readStatus(value: unknown, context: string): OwnerReportRowStatus {
  if (value === undefined || value === null) return "ok";
  if (isRowStatus(value)) return value;
  throw new OwnerReportContractError("INVALID_ROW", `${context}.status is not a known row status`);
}

/** Only ok captures contain measurements; unavailable means the whole row. */
function readCaptureMetric(value: unknown, status: OwnerReportRowStatus): number | null {
  return status === "ok" ? readMetric(value) : null;
}

/**
 * A boolean flag. A non-boolean is refused rather than read as false: a
 * flag that silently turns off is how a partial or truncated state stops
 * being reported.
 */
function readBoolean(value: unknown, field: string, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new OwnerReportContractError("INVALID_INPUT", `${context}.${field} must be a boolean`);
  }
  return value;
}

/** A collection must be a collection. A missing one is a broken reader. */
function requireArray(value: unknown, field: string): void {
  if (!Array.isArray(value)) {
    throw new OwnerReportContractError("INVALID_INPUT", `${field} must be an array`);
  }
}

function readCalendarDate(value: unknown, field: string, context: string): string {
  const text = requireText(value, field, context);
  if (!isCalendarDate(text)) {
    throw new OwnerReportContractError("INVALID_ROW", `${context}.${field} must be a YYYY-MM-DD date`);
  }
  return text;
}

function normalizeMediaRow(
  row: unknown,
  scope: OwnerReportScope,
  context: string,
): NormalizedMediaRow {
  if (!isRecord(row)) {
    throw new OwnerReportContractError("INVALID_ROW", `${context} must be an object`);
  }
  assertRowScope(row, scope, context);
  const published = readInstant(row.publishedAt, "publishedAt", context);
  const captured = readInstant(row.capturedAt, "capturedAt", context);
  const status = readStatus(row.status, context);
  return {
    id: requireText(row.id, "id", context),
    mediaId: requireText(row.mediaId, "mediaId", context),
    postId: optionalText(row.postId),
    publishedAt: published.text,
    publishedMs: published.ms,
    capturedAt: captured.text,
    capturedMs: captured.ms,
    capturedOn: readCalendarDate(row.capturedOn, "capturedOn", context),
    captureTimezone: requireText(row.captureTimezone, "captureTimezone", context),
    mediaProductType: optionalText(row.mediaProductType),
    mediaType: optionalText(row.mediaType),
    permalink: optionalText(row.permalink),
    thumbnailUrl: optionalText(row.thumbnailUrl),
    status,
    views: readCaptureMetric(row.views, status),
    reach: readCaptureMetric(row.reach, status),
    likes: readCaptureMetric(row.likes, status),
    comments: readCaptureMetric(row.comments, status),
    saved: readCaptureMetric(row.saved, status),
    shares: readCaptureMetric(row.shares, status),
    totalInteractions: readCaptureMetric(row.totalInteractions, status),
    follows: readCaptureMetric(row.follows, status),
    profileVisits: readCaptureMetric(row.profileVisits, status),
    replies: readCaptureMetric(row.replies, status),
    igReelsAvgWatchTimeMs: readCaptureMetric(row.igReelsAvgWatchTimeMs, status),
  };
}

function normalizeDailyRow(
  row: unknown,
  scope: OwnerReportScope,
  context: string,
): NormalizedDailyRow {
  if (!isRecord(row)) {
    throw new OwnerReportContractError("INVALID_ROW", `${context} must be an object`);
  }
  assertRowScope(row, scope, context);
  const captured = readInstant(row.capturedAt, "capturedAt", context);
  const status = readStatus(row.status, context);
  return {
    id: requireText(row.id, "id", context),
    metricDate: readCalendarDate(row.metricDate, "metricDate", context),
    providerDate: readCalendarDate(row.providerDate, "providerDate", context),
    periodStart: readOptionalInstant(row.periodStart, "periodStart", context),
    periodEnd: readOptionalInstant(row.periodEnd, "periodEnd", context),
    providerTimezone: optionalText(row.providerTimezone),
    status,
    capturedAt: captured.text,
    capturedMs: captured.ms,
    reach: readCaptureMetric(row.reach, status),
    views: readCaptureMetric(row.views, status),
    accountsEngaged: readCaptureMetric(row.accountsEngaged, status),
    totalInteractions: readCaptureMetric(row.totalInteractions, status),
    likes: readCaptureMetric(row.likes, status),
    comments: readCaptureMetric(row.comments, status),
    saves: readCaptureMetric(row.saves, status),
    shares: readCaptureMetric(row.shares, status),
    follows: readCaptureMetric(row.follows, status),
    unfollows: readCaptureMetric(row.unfollows, status),
  };
}

function normalizeProfileRow(
  row: unknown,
  scope: OwnerReportScope,
  context: string,
): NormalizedProfileRow {
  if (!isRecord(row)) {
    throw new OwnerReportContractError("INVALID_ROW", `${context} must be an object`);
  }
  assertRowScope(row, scope, context);
  const observed = readInstant(row.observedAt, "observedAt", context);
  const status = readStatus(row.status, context);
  return {
    id: requireText(row.id, "id", context),
    observedAt: observed.text,
    observedMs: observed.ms,
    observedOn: readCalendarDate(row.observedOn, "observedOn", context),
    captureTimezone: requireText(row.captureTimezone, "captureTimezone", context),
    status,
    followersCount: readCaptureMetric(row.followersCount, status),
    mediaCount: readCaptureMetric(row.mediaCount, status),
  };
}

/* -------------------------------------------------------------------------- */
/* Identity and grouping                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The content of a capture, without its row id.
 *
 * The row id identifies a row, not a capture: the same logical capture read
 * twice may carry two ids, and that is a duplicate, not a contradiction.
 * Everything else about the capture is part of its identity.
 */
function mediaSignature(row: NormalizedMediaRow): string {
  return JSON.stringify([
    row.mediaId,
    row.postId,
    row.publishedAt,
    row.capturedAt,
    row.capturedOn,
    row.captureTimezone,
    row.mediaProductType,
    row.mediaType,
    row.status,
    row.views,
    row.reach,
    row.likes,
    row.comments,
    row.saved,
    row.shares,
    row.totalInteractions,
    row.follows,
    row.profileVisits,
    row.replies,
    row.igReelsAvgWatchTimeMs,
  ]);
}

function dailySignature(row: NormalizedDailyRow): string {
  return JSON.stringify([
    row.metricDate,
    row.providerDate,
    row.periodStart,
    row.periodEnd,
    row.providerTimezone,
    row.status,
    row.capturedAt,
    row.reach,
    row.views,
    row.accountsEngaged,
    row.totalInteractions,
    row.likes,
    row.comments,
    row.saves,
    row.shares,
    row.follows,
    row.unfollows,
  ]);
}

function profileSignature(row: NormalizedProfileRow): string {
  return JSON.stringify([
    row.observedAt,
    row.observedOn,
    row.captureTimezone,
    row.status,
    row.followersCount,
    row.mediaCount,
  ]);
}

/**
 * Refuse two rows that claim the same identity but disagree.
 *
 * A row id identifies one capture: the same id with a different payload is
 * a contradiction, not a duplicate. A media with two captures on the same
 * capture day that disagree is the same contradiction one level up. Either
 * one means the reader handed over inconsistent data, and the report must
 * say so instead of picking a winner.
 */
function rejectConflictingRows<T>(
  rows: readonly T[],
  signature: (row: T) => string,
  identity: (row: T) => string,
  code: "CONFLICTING_DUPLICATE_ROW" | "CONFLICTING_CAPTURE_IDENTITY",
  what: string,
): void {
  const seen = new Map<string, string>();
  for (const row of rows) {
    const key = identity(row);
    const value = signature(row);
    const previous = seen.get(key);
    if (previous === undefined) {
      seen.set(key, value);
      continue;
    }
    if (previous !== value) {
      throw new OwnerReportContractError(
        code,
        `two ${what} rows share the identity "${key}" but disagree`,
      );
    }
  }
}

type MediaGroup = {
  mediaId: string;
  /** The newest completed capture, or null when there is none yet. */
  latest: NormalizedMediaRow | null;
  /** The newest row of any status, used for window and coverage checks. */
  latestAny: NormalizedMediaRow;
};

function groupMediaRows(rows: readonly NormalizedMediaRow[]): MediaGroup[] {
  const groups = new Map<string, NormalizedMediaRow[]>();
  for (const row of rows) {
    const list = groups.get(row.mediaId);
    if (list) list.push(row);
    else groups.set(row.mediaId, [row]);
  }

  const result: MediaGroup[] = [];
  for (const [mediaId, group] of groups) {
    // Newest first; the id breaks a tie on the capture instant so the
    // selection is deterministic whatever order the reader returned.
    group.sort((a, b) => {
      const instantOrder = compareInstants(b.capturedMs, b.capturedAt, a.capturedMs, a.capturedAt);
      if (instantOrder !== 0) return instantOrder;
      if (a.id === b.id) return 0;
      return a.id < b.id ? 1 : -1;
    });
    const latestAny = group[0];
    const completed = group.filter((row) => row.status === "ok" || row.status === "unavailable");
    result.push({ mediaId, latest: completed[0] ?? null, latestAny });
  }
  return result;
}

/* -------------------------------------------------------------------------- */
/* Classification and cohorts                                                   */
/* -------------------------------------------------------------------------- */

type MediaClassification =
  | { kind: "supported"; format: OutlierFormat }
  | { kind: "story" }
  | { kind: "unsupported" }
  | { kind: "unknown" };

/**
 * The product type decides the format. A `VIDEO` media type is NOT a reel:
 * Meta reports the product type separately and a reel is not the only
 * video. When the product type is missing the media is unclassified, and
 * an unclassified media is never guessed into a cohort.
 */
function classify(row: NormalizedMediaRow): MediaClassification {
  const productType = row.mediaProductType;
  if (productType === "REELS") return { kind: "supported", format: "reel" };
  if (productType === "FEED") return { kind: "supported", format: "non_reel" };
  if (productType === "STORY") return { kind: "story" };
  if (productType === "AD") return { kind: "unsupported" };
  return { kind: "unknown" };
}

type CohortItem = {
  mediaId: string;
  format: OutlierFormat;
  basis: OwnerReportMetricBasis | null;
  value: number | null;
  publishedAt: string;
};

/**
 * The metric a media is scored on.
 *
 * A reel is scored on views. A non-reel prefers reach and falls back to
 * the interactions cohort, which is labelled explicitly so it is never
 * mistaken for a reach cohort. Reach and interactions never share a
 * median.
 */
function cohortItemFor(row: NormalizedMediaRow, format: OutlierFormat): CohortItem {
  if (format === "reel") {
    return {
      mediaId: row.mediaId,
      format,
      basis: row.views === null ? null : "views",
      value: row.views,
      publishedAt: row.publishedAt,
    };
  }
  if (row.reach !== null) {
    return {
      mediaId: row.mediaId,
      format,
      basis: "reach",
      value: row.reach,
      publishedAt: row.publishedAt,
    };
  }
  if (row.totalInteractions !== null) {
    return {
      mediaId: row.mediaId,
      format,
      basis: "interactions",
      value: row.totalInteractions,
      publishedAt: row.publishedAt,
    };
  }
  return {
    mediaId: row.mediaId,
    format,
    basis: null,
    value: null,
    publishedAt: row.publishedAt,
  };
}

/* -------------------------------------------------------------------------- */
/* Derived values                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The engagement rate, in percent.
 *
 * It needs a known, positive reach AND every required numerator. A single
 * unavailable numerator makes the rate unavailable - the sum is never
 * taken over a missing value and a missing value is never read as zero.
 */
function computeEngagementRate(row: NormalizedMediaRow): OwnerReportEngagementRate {
  const unavailable: OwnerReportEngagementRate = {
    value: null,
    unit: "percent",
    denominatorMetric: "reach",
    numeratorMetrics: ["likes", "comments", "saved", "shares"],
  };
  const reach = row.reach;
  if (reach === null || reach <= 0) return unavailable;

  let sum = 0;
  for (const value of [row.likes, row.comments, row.saved, row.shares]) {
    if (value === null) return unavailable;
    sum += value;
  }
  const rate = (sum / reach) * 100;
  return { ...unavailable, value: Number.isFinite(rate) ? rate : null };
}

function noDataOutlier(basis: OwnerReportMetricBasis | null): OwnerReportOutlier {
  return {
    score: null,
    label: "no_data",
    baselineMedian: null,
    baselineSize: 0,
    metricBasis: basis,
  };
}

/* -------------------------------------------------------------------------- */
/* Freshness and completeness                                                   */
/* -------------------------------------------------------------------------- */

function normalizeFreshness(input: OwnerReportFreshnessInput): OwnerReportFreshness {
  if (!isRecord(input)) {
    throw new OwnerReportContractError("INVALID_INPUT", "freshness must be an object");
  }
  if (!isSyncStatus(input.status)) {
    throw new OwnerReportContractError("INVALID_INPUT", "freshness.status is not a known status");
  }
  if (input.reason !== null && input.reason !== undefined && !isReasonCode(input.reason)) {
    throw new OwnerReportContractError("INVALID_INPUT", "freshness.reason is not a known reason code");
  }
  return {
    status: input.status,
    lastAttemptAt: readOptionalInstant(input.lastAttemptAt, "lastAttemptAt", "freshness"),
    lastSuccessAt: readOptionalInstant(input.lastSuccessAt, "lastSuccessAt", "freshness"),
    lastPartialAt: readOptionalInstant(input.lastPartialAt, "lastPartialAt", "freshness"),
    partial: readBoolean(input.partial, "partial", "freshness"),
    truncated: readBoolean(input.truncated, "truncated", "freshness"),
    retryAt: readOptionalInstant(input.retryAt, "retryAt", "freshness"),
    reason: input.reason ?? null,
  };
}

function normalizeCompleteness(input: OwnerReportCompletenessInput): OwnerReportCompleteness {
  if (!isRecord(input)) {
    throw new OwnerReportContractError("INVALID_INPUT", "completeness must be an object");
  }
  if (!isCoverage(input.coverage)) {
    throw new OwnerReportContractError(
      "INVALID_INPUT",
      "completeness.coverage is not a known coverage",
    );
  }
  return {
    baselineHistoryComplete: readBoolean(
      input.baselineHistoryComplete,
      "baselineHistoryComplete",
      "completeness",
    ),
    inventoryTruncated: readBoolean(input.inventoryTruncated, "inventoryTruncated", "completeness"),
    coverage: input.coverage,
    oldestMediaPublishedAt: readOptionalInstant(
      input.oldestMediaPublishedAt,
      "oldestMediaPublishedAt",
      "completeness",
    ),
    newestMediaPublishedAt: readOptionalInstant(
      input.newestMediaPublishedAt,
      "newestMediaPublishedAt",
      "completeness",
    ),
  };
}

/* -------------------------------------------------------------------------- */
/* Pagination                                                                   */
/* -------------------------------------------------------------------------- */

function compareMediaOrder(a: NormalizedMediaRow, b: NormalizedMediaRow): number {
  const instantOrder = compareInstants(b.publishedMs, b.publishedAt, a.publishedMs, a.publishedAt);
  if (instantOrder !== 0) return instantOrder;
  if (a.mediaId === b.mediaId) return 0;
  return a.mediaId < b.mediaId ? -1 : 1;
}

/** True when a media sorts strictly after the cursor position. */
function isAfterCursor(row: NormalizedMediaRow, cursorMs: number, cursor: OwnerReportCursor): boolean {
  const instantOrder = compareInstants(row.publishedMs, row.publishedAt, cursorMs, cursor.publishedAt);
  if (instantOrder !== 0) return instantOrder < 0;
  return row.mediaId > cursor.mediaId;
}

/* -------------------------------------------------------------------------- */
/* The assembler                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Assemble the owner report.
 *
 * @param input The repository input. The scope, the instant and the rows
 *   are the caller's responsibility; this function validates them and
 *   refuses what it cannot trust.
 * @throws OwnerReportContractError for a structurally broken input, a row
 *   that belongs to another owner or account, or two rows that contradict
 *   each other.
 */
export function assembleOwnerReport(input: OwnerReportAssemblyInput): OwnerReport {
  if (!isRecord(input)) {
    throw new OwnerReportContractError("INVALID_INPUT", "the report input must be an object");
  }
  const scope = input.scope;
  if (!isRecord(scope)) {
    throw new OwnerReportContractError("INVALID_SCOPE", "scope must be an object");
  }
  const ownerId = requireText(scope.ownerId, "ownerId", "scope", "INVALID_SCOPE");
  const socialAccountId = requireText(
    scope.socialAccountId,
    "socialAccountId",
    "scope",
    "INVALID_SCOPE",
  );
  if (scope.platform !== "instagram") {
    throw new OwnerReportContractError("INVALID_SCOPE", "scope.platform must be instagram");
  }
  const checkedScope: OwnerReportScope = { ownerId, socialAccountId, platform: "instagram" };

  const now = input.now;
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) {
    throw new OwnerReportContractError("INVALID_NOW", "now must be a valid Date");
  }
  const nowMs = now.getTime();

  const request = input.request;
  if (!isRecord(request)) {
    throw new OwnerReportContractError("INVALID_INPUT", "request must be an object");
  }
  if (typeof request.limit !== "number") {
    throw new OwnerReportContractError("INVALID_LIMIT", "limit must be a positive integer");
  }
  const { periodDays, limit, cursor } = parseOwnerReportRequest(request);
  requireArray(input.mediaSnapshots, "mediaSnapshots");
  requireArray(input.baselineHistory, "baselineHistory");
  requireArray(input.accountDaily, "accountDaily");
  requireArray(input.profileObservations, "profileObservations");
  const windowStartMs = nowMs - periodDays * MILLISECONDS_PER_DAY;
  const windowEndMs = nowMs;

  /* --- media rows ---------------------------------------------------- */

  const displayRows: NormalizedMediaRow[] = [];
  input.mediaSnapshots.forEach((row, index) => {
    displayRows.push(normalizeMediaRow(row, checkedScope, `mediaSnapshots[${index}]`));
  });
  const historyRows: NormalizedMediaRow[] = [];
  input.baselineHistory.forEach((row, index) => {
    historyRows.push(normalizeMediaRow(row, checkedScope, `baselineHistory[${index}]`));
  });

  const mediaRows = [...displayRows, ...historyRows];

  rejectConflictingRows(
    mediaRows,
    mediaSignature,
    (row) => `row:${row.id}`,
    "CONFLICTING_DUPLICATE_ROW",
    "media snapshot",
  );
  rejectConflictingRows(
    mediaRows,
    mediaSignature,
    (row) => `capture:${row.mediaId}:${row.capturedAt}`,
    "CONFLICTING_CAPTURE_IDENTITY",
    "media snapshot",
  );

  const groups = groupMediaRows(mediaRows);
  const displayIds = new Set(displayRows.map((row) => row.mediaId));

  /* --- cohorts ------------------------------------------------------- */

  const cohortByKey = new Map<string, CohortItem[]>();
  const cohortItemByMedia = new Map<string, CohortItem>();
  const classified = new Map<string, MediaClassification>();

  for (const group of groups) {
    const row = group.latest;
    if (row === null) continue;
    const classification = classify(row);
    classified.set(group.mediaId, classification);
    if (classification.kind !== "supported") continue;
    if (row.publishedMs > nowMs) continue;
    const item = cohortItemFor(row, classification.format);
    cohortItemByMedia.set(group.mediaId, item);
    const key = `${item.format}|${item.basis ?? "none"}`;
    const bucket = cohortByKey.get(key);
    if (bucket) bucket.push(item);
    else cohortByKey.set(key, [item]);
  }

  const outlierByMedia = new Map<string, OwnerReportOutlier>();
  for (const items of cohortByKey.values()) {
    const inputs: OutlierInput[] = items.map((item) => ({
      id: item.mediaId,
      format: item.format,
      publishedAt: item.publishedAt,
      value: item.value,
    }));
    // The canonical defaults are the plan's: a 48 hour maturity window, a
    // minimum baseline of six and a baseline cap of twelve. The canonical
    // module owns them; the assembler does not second-guess them here.
    const results = computeOutlierScores(inputs, now);
    results.forEach((result, index) => {
      const item = items[index];
      outlierByMedia.set(item.mediaId, {
        score: result.score,
        label: result.label,
        baselineMedian: result.baselineMedian,
        baselineSize: result.baselineSize,
        metricBasis: item.basis,
      });
    });
  }

  /* --- display window ------------------------------------------------ */

  const coverage: OwnerReportMediaCoverage = {
    received: displayIds.size,
    inWindow: 0,
    reel: 0,
    nonReel: 0,
    excludedStory: 0,
    excludedUnsupported: 0,
    excludedUnknown: 0,
    excludedNoCapture: 0,
    excludedFuture: 0,
  };

  const windowRows: NormalizedMediaRow[] = [];
  for (const group of groups) {
    if (!displayIds.has(group.mediaId)) continue;
    const row = group.latest;
    if (row === null) {
      // No completed capture yet. The newest attempt still tells us the
      // publication time, so the media can be counted in the window.
      if (
        group.latestAny.publishedMs >= windowStartMs &&
        group.latestAny.publishedMs <= windowEndMs
      ) {
        coverage.inWindow += 1;
        coverage.excludedNoCapture += 1;
      }
      continue;
    }
    if (row.publishedMs > nowMs) {
      coverage.excludedFuture += 1;
      continue;
    }
    if (row.publishedMs < windowStartMs || row.publishedMs > windowEndMs) continue;

    coverage.inWindow += 1;
    const classification = classified.get(group.mediaId);
    if (!classification || classification.kind !== "supported") {
      if (classification?.kind === "story") coverage.excludedStory += 1;
      else if (classification?.kind === "unsupported") coverage.excludedUnsupported += 1;
      else coverage.excludedUnknown += 1;
      continue;
    }
    if (classification.format === "reel") coverage.reel += 1;
    else coverage.nonReel += 1;
    windowRows.push(row);
  }

  windowRows.sort(compareMediaOrder);

  /* --- paging -------------------------------------------------------- */

  let start = 0;
  if (cursor !== null) {
    const cursorMs = parseInstant(cursor.publishedAt, "publishedAt", "cursor", "INVALID_CURSOR");
    const index = windowRows.findIndex((row) => isAfterCursor(row, cursorMs, cursor));
    start = index === -1 ? windowRows.length : index;
  }
  const pageRows = windowRows.slice(start, start + limit);
  const hasMore = start + limit < windowRows.length;
  const lastRow = pageRows.length > 0 ? pageRows[pageRows.length - 1] : null;
  const nextCursor: OwnerReportCursor | null = hasMore && lastRow !== null
    ? { publishedAt: lastRow.publishedAt, mediaId: lastRow.mediaId }
    : null;

  const items: OwnerReportMediaItem[] = pageRows.map((row) => {
    const item = cohortItemByMedia.get(row.mediaId);
    const outlier = outlierByMedia.get(row.mediaId) ?? noDataOutlier(item?.basis ?? null);
    const classification = classified.get(row.mediaId);
    if (!classification || classification.kind !== "supported") {
      throw new OwnerReportContractError(
        "INVALID_ROW",
        `media "${row.mediaId}" was classified inconsistently`,
      );
    }
    return {
      mediaId: row.mediaId,
      postId: row.postId,
      publishedAt: row.publishedAt,
      capturedAt: row.capturedAt,
      capturedOn: row.capturedOn,
      captureTimezone: row.captureTimezone,
      format: classification.format,
      mediaProductType: row.mediaProductType,
      mediaType: row.mediaType,
      permalink: row.permalink,
      thumbnailUrl: row.thumbnailUrl,
      status: row.status,
      metrics: {
        views: row.views,
        reach: row.reach,
        likes: row.likes,
        comments: row.comments,
        saved: row.saved,
        shares: row.shares,
        totalInteractions: row.totalInteractions,
        follows: row.follows,
        profileVisits: row.profileVisits,
        replies: row.replies,
        igReelsAvgWatchTimeMs: row.igReelsAvgWatchTimeMs,
      },
      engagementRate: computeEngagementRate(row),
      outlier,
    };
  });

  /* --- account days -------------------------------------------------- */

  const dailyRows: NormalizedDailyRow[] = [];
  input.accountDaily.forEach((row, index) => {
    dailyRows.push(normalizeDailyRow(row, checkedScope, `accountDaily[${index}]`));
  });
  rejectConflictingRows(
    dailyRows,
    dailySignature,
    (row) => `row:${row.id}`,
    "CONFLICTING_DUPLICATE_ROW",
    "account daily",
  );
  rejectConflictingRows(
    dailyRows,
    dailySignature,
    (row) => `day:${row.metricDate}:${row.capturedAt}`,
    "CONFLICTING_CAPTURE_IDENTITY",
    "account daily",
  );

  const metricDateStart = addUtcDays(utcDateString(nowMs), -(periodDays - 1));
  const metricDateEnd = utcDateString(nowMs);
  const dailyByDate = new Map<string, NormalizedDailyRow>();
  for (const row of dailyRows) {
    const existing = dailyByDate.get(row.metricDate);
    if (existing === undefined) {
      dailyByDate.set(row.metricDate, row);
      continue;
    }
    // Failed/pending attempts cannot erase a completed capture. An explicit
    // unavailable capture is terminal and may replace earlier measurements.
    const completed = row.status === "ok" || row.status === "unavailable";
    const existingCompleted = existing.status === "ok" || existing.status === "unavailable";
    if (completed !== existingCompleted) {
      if (completed) dailyByDate.set(row.metricDate, row);
      continue;
    }
    const instantOrder = compareInstants(row.capturedMs, row.capturedAt, existing.capturedMs, existing.capturedAt);
    if (instantOrder > 0) dailyByDate.set(row.metricDate, row);
    else if (instantOrder === 0 && row.id > existing.id) {
      dailyByDate.set(row.metricDate, row);
    }
  }
  const daily: OwnerReportDailyRow[] = [...dailyByDate.values()]
    .filter((row) => row.metricDate >= metricDateStart && row.metricDate <= metricDateEnd)
    .sort((a, b) => (a.metricDate < b.metricDate ? -1 : a.metricDate > b.metricDate ? 1 : 0))
    .map((row) => ({
      metricDate: row.metricDate,
      providerDate: row.providerDate,
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      providerTimezone: row.providerTimezone,
      status: row.status,
      capturedAt: row.capturedAt,
      reach: row.reach,
      views: row.views,
      accountsEngaged: row.accountsEngaged,
      totalInteractions: row.totalInteractions,
      likes: row.likes,
      comments: row.comments,
      saves: row.saves,
      shares: row.shares,
      follows: row.follows,
      unfollows: row.unfollows,
    }));

  /* --- profile observations ------------------------------------------ */

  const profileRows: NormalizedProfileRow[] = [];
  input.profileObservations.forEach((row, index) => {
    profileRows.push(normalizeProfileRow(row, checkedScope, `profileObservations[${index}]`));
  });
  rejectConflictingRows(
    profileRows,
    profileSignature,
    (row) => `row:${row.id}`,
    "CONFLICTING_DUPLICATE_ROW",
    "profile observation",
  );
  rejectConflictingRows(
    profileRows,
    profileSignature,
    (row) => `observation:${row.observedAt}`,
    "CONFLICTING_CAPTURE_IDENTITY",
    "profile observation",
  );

  const profiles: OwnerReportProfileObservation[] = [...new Map(
    profileRows.map((row) => [row.observedAt, row]),
  ).values()]
    .sort((a, b) => compareInstants(a.observedMs, a.observedAt, b.observedMs, b.observedAt))
    .map((row) => ({
      observedAt: row.observedAt,
      observedOn: row.observedOn,
      captureTimezone: row.captureTimezone,
      status: row.status,
      followersCount: row.followersCount,
      mediaCount: row.mediaCount,
    }));
  const completedProfiles = profiles.filter((row) => row.status === "ok" || row.status === "unavailable");

  /* --- report -------------------------------------------------------- */

  const report: OwnerReport = {
    schemaVersion: OWNER_REPORT_SCHEMA_VERSION,
    source: "graph_own",
    scope: checkedScope,
    generatedAt: new Date(nowMs).toISOString(),
    period: {
      days: periodDays,
      windowStart: new Date(windowStartMs).toISOString(),
      windowEnd: new Date(windowEndMs).toISOString(),
      metricDateStart,
      metricDateEnd,
    },
    account: {
      daily,
      profiles,
      latestProfileObservation: completedProfiles.length > 0
        ? completedProfiles[completedProfiles.length - 1]
        : null,
    },
    media: {
      page: {
        items,
        limit,
        returned: items.length,
        hasMore,
        nextCursor,
      },
      coverage,
    },
    freshness: normalizeFreshness(input.freshness),
    completeness: normalizeCompleteness(input.completeness),
    lagNote: OWNER_REPORT_LAG_NOTE,
  };

  assertNoNonFiniteNumbers(report, "report");
  return report;
}

/**
 * The report is serialised to JSON and shipped to a browser. A NaN or an
 * Infinity would be silently rewritten to null on the way out, so the
 * assembler refuses to produce one instead of letting it change meaning
 * after the fact.
 */
function assertNoNonFiniteNumbers(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new OwnerReportContractError("INVALID_ROW", `${path} is not a finite number`);
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
