/**
 * The frontend mirror of the frozen competitor tracking report contract.
 *
 * WHAT THIS MODULE OWNS
 *
 *   1. The types of the public DTO v1 (spec §5).
 *   2. The runtime validation of an untrusted report payload.
 *   3. The closed set of client-facing report error codes.
 *
 * WHY THE CONTRACT IS MIRRORED AND NOT IMPORTED
 *
 *   The authoritative contract lives in
 *   `supabase/functions/competitor-tracking-report/contracts.ts`. It is a
 *   Deno module: it imports `../_shared/outlierScore.ts` and carries the
 *   `.ts` extension Deno requires. Importing it from the browser bundle
 *   would drag Deno-only code (and the whole outlier module) into the
 *   client, so the types are mirrored here explicitly and versioned
 *   together (ARCHITECTURE §22: "When cross-runtime sharing is not
 *   practical, generate or explicitly version mirrored contracts and test
 *   compatibility").
 *
 *   The mirror is therefore NOT a copy of the backend's reader. It is a
 *   SECOND, INDEPENDENT reader: the frontend refuses anything it does not
 *   understand instead of trusting the wire. That is why the field names
 *   stay snake_case exactly as the wire carries them, and why the field
 *   set is validated key by key.
 *
 * THE RULES THIS MODULE ENFORCES
 *
 *   - NULL IS UNAVAILABLE, NEVER ZERO. A null measurement stays null all
 *     the way to the UI.
 *   - AN UNKNOWN ENVELOPE VERSION FAILS. A version this module does not
 *     know is a payload it cannot interpret.
 *   - A MISSING KEY FAILS. Every key the DTO declares is required; only
 *     its VALUE may be null where the contract allows null.
 *   - AN UNSAFE NUMBER FAILS. A count beyond 2^53 does not survive
 *     JSON.parse exactly, and a rounded follower count is a wrong
 *     follower count, so a non-safe-integer count is refused rather than
 *     rounded.
 *   - NO ANALYTICS. There is no growth, weekly or outlier arithmetic
 *     here. The server computed those; this module only carries them.
 */

/** The version of the competitor tracking report DTO. */
export const COMPETITOR_REPORT_SCHEMA_VERSION = 1;

/** The capture timezone the report is expressed in. */
export const COMPETITOR_REPORT_CAPTURE_TIMEZONE = "Asia/Kuwait";

/** The default page size when the caller does not ask for one. */
export const COMPETITOR_REPORT_DEFAULT_LIMIT = 20;

/** The hard page-size ceiling. A report is never an unbounded dump. */
export const COMPETITOR_REPORT_MAX_LIMIT = 50;

/** The hard cursor ceiling, in characters. */
export const COMPETITOR_REPORT_MAX_CURSOR_LENGTH = 2048;

/**
 * The stable client-facing report error codes. They are a CLOSED set and
 * they are the server's codes verbatim.
 */
export type CompetitorReportErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "REPORT_UNAVAILABLE";

/**
 * A refusal raised while reading an untrusted report payload.
 *
 * It is a typed error, never a thrown string (ARCHITECTURE §32).
 */
export class CompetitorReportContractError extends Error {
  readonly code: CompetitorReportErrorCode;

  constructor(code: CompetitorReportErrorCode, message: string) {
    super(message);
    this.name = "CompetitorReportContractError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* The public DTO                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The source of one observation.
 *
 * The report only ever carries `official`, `apify` or `unknown`. The
 * owner's own `graph_own` source is a different population and is never
 * mixed in.
 */
export type CompetitorReportSource = "official" | "apify" | "unknown";

/** The metric one cohort was scored on. Units are never mixed. */
export type CompetitorReportMetricBasis = "public_views" | "public_interactions";

/** The existing four-key quota shape of `read_own_competitor_quota()`. */
export type CompetitorReportQuota = {
  max_tracked_competitors: number | null;
  unlimited: boolean;
  tracked_active: number;
  remaining: number | null;
};

/** The latest successful profile observation of one entry. */
export type CompetitorReportProfileObservation = {
  followers_count: number | null;
  media_count: number | null;
  captured_at: string;
  captured_on: string;
  source: CompetitorReportSource;
};

/** The committed capture state of one entry. Unknown is null. */
export type CompetitorReportFreshness = {
  last_capture_at: string | null;
  last_full_success_at: string | null;
  last_partial_at: string | null;
  job_status: string | null;
  reason_code: string | null;
};

/** Why a growth comparison is unavailable. Null means "comparable". */
export type CompetitorReportGrowthReason =
  | "first_observation"
  | "missing_baseline"
  | "zero_baseline"
  | "stale_baseline"
  | "unavailable_metric"
  | "source_changed"
  | "baseline_policy_unset";

/**
 * One growth comparison.
 *
 * A null output means UNAVAILABLE, never zero. The reason names which
 * case it is, so the UI never has to guess.
 */
export type CompetitorReportGrowth = {
  absolute: number | null;
  percent: number | null;
  baseline_at: string | null;
  observed_at: string | null;
  interval_days: number | null;
  reason: CompetitorReportGrowthReason | null;
};

/** How much of the seven-day window the stored evidence actually covers. */
export type CompetitorReportWeeklyCoverage = "complete" | "partial" | "unknown";

/**
 * The weekly posting rate.
 *
 * `posts_per_week` is non-null ONLY when the coverage proves the window:
 * a partial or unknown window never carries an extrapolated rate.
 */
export type CompetitorReportWeekly = {
  observed_count: number;
  posts_per_week: number | null;
  interval_start: string | null;
  interval_end: string | null;
  coverage: CompetitorReportWeeklyCoverage;
  reason: string | null;
};

/** One tracked competitor. */
export type CompetitorReportEntry = {
  watchlist_id: string;
  username: string;
  label: string | null;
  is_active: boolean;
  removed_at: string | null;
  status: string;
  last_error_code: string | null;
  next_retry_at: string | null;
  /** `removed_at + 90 elapsed days`, or null while the entry is active. */
  cleanup_eligible_at: string | null;
  profile: CompetitorReportProfileObservation | null;
  freshness: CompetitorReportFreshness;
  growth_7d: CompetitorReportGrowth;
  growth_30d: CompetitorReportGrowth;
  weekly: CompetitorReportWeekly;
};

/**
 * The canonical outlier verdict of one media item.
 *
 * `id`, `score`, `label`, `baselineMedian` and `baselineSize` are the
 * canonical `_shared/outlierScore.ts` shape and are never renamed.
 */
export type CompetitorReportOutlierLabel =
  | "outlier"
  | "above"
  | "normal"
  | "below"
  | "too_early"
  | "no_data"
  | "small_baseline";

export type CompetitorReportOutlier = {
  id: string;
  score: number | null;
  label: CompetitorReportOutlierLabel;
  baselineMedian: number | null;
  baselineSize: number;
  metric_basis: CompetitorReportMetricBasis | null;
  source: CompetitorReportSource;
  reason: string | null;
};

/** One observed media item of one tracked competitor. */
export type CompetitorReportMedia = {
  ig_media_id: string;
  published_at: string;
  captured_at: string;
  media_product_type: string | null;
  media_type: string | null;
  thumbnail_url: string | null;
  permalink: string | null;
  caption: string | null;
  like_count: number | null;
  comments_count: number | null;
  view_count: number | null;
  source: CompetitorReportSource;
  outlier: CompetitorReportOutlier;
};

/** The list envelope. */
export type CompetitorReportList = {
  version: typeof COMPETITOR_REPORT_SCHEMA_VERSION;
  as_of: string;
  capture_timezone: typeof COMPETITOR_REPORT_CAPTURE_TIMEZONE;
  quota: CompetitorReportQuota;
  next_cursor: string | null;
  entries: CompetitorReportEntry[];
};

/** The detail envelope. */
export type CompetitorReportDetail = {
  version: typeof COMPETITOR_REPORT_SCHEMA_VERSION;
  as_of: string;
  capture_timezone: typeof COMPETITOR_REPORT_CAPTURE_TIMEZONE;
  quota: CompetitorReportQuota;
  next_cursor: string | null;
  entry: CompetitorReportEntry | null;
  media: CompetitorReportMedia[];
};

export type CompetitorReport = CompetitorReportList | CompetitorReportDetail;

/* -------------------------------------------------------------------------- */
/* Primitive readers                                                             */
/* -------------------------------------------------------------------------- */

/** Whether the value is a plain object (and not an array). */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(field: string, context: string, expectation: string): never {
  throw new CompetitorReportContractError(
    "REPORT_UNAVAILABLE",
    `${context}.${field} ${expectation}`,
  );
}

function requireRecord(value: unknown, context: string): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context} must be an object`,
    );
  }
  return value;
}

function requireArray(value: unknown, field: string, context: string): unknown[] {
  if (!Array.isArray(value)) fail(field, context, "must be an array");
  return value;
}

/** A required, non-blank string. */
function requireText(value: unknown, field: string, context: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    fail(field, context, "must be a non-empty string");
  }
  return value;
}

/**
 * A key that the DTO declares.
 *
 * Every key of the DTO is required. Only its VALUE may be null, and
 * only where the contract allows null. A missing key is a payload this
 * module does not understand, not an absent value.
 */
function requireKey(
  record: Record<string, unknown>,
  field: string,
  context: string,
): unknown {
  if (!(field in record)) fail(field, context, "is missing");
  return record[field];
}

/** An optional string. The KEY must exist; its value may be null. */
function optionalTextField(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  const value = requireKey(record, field, context);
  if (value === null) return null;
  if (typeof value !== "string") fail(field, context, "must be a string");
  return value.trim() === "" ? null : value;
}

/** A required boolean flag. */
function requireFlag(value: unknown, field: string, context: string): boolean {
  if (typeof value !== "boolean") fail(field, context, "must be a boolean");
  return value;
}

/**
 * A COUNT.
 *
 * A count is a non-negative integer in the database, so a value that is not
 * a safe integer is a broken payload and the read fails closed. A rounded
 * follower count is a wrong follower count.
 */
function requireCount(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    fail(field, context, "must be a safe integer");
  }
  return value;
}

/** An optional COUNT. The KEY must exist; its value may be null. */
function optionalCountField(
  record: Record<string, unknown>,
  field: string,
  context: string,
): number | null {
  const value = requireKey(record, field, context);
  if (value === null) return null;
  return requireCount(value, field, context);
}

/**
 * A MEASUREMENT that may be fractional (a percentage, a day count).
 *
 * A non-finite value is refused: `NaN` and `Infinity` are not answers, and
 * they would silently become null on the way to the browser.
 */
function requireFiniteNumber(value: unknown, field: string, context: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(field, context, "must be a finite number");
  }
  return value;
}

/** An optional MEASUREMENT. Absent stays absent. */
function optionalFiniteNumber(
  value: unknown,
  field: string,
  context: string,
): number | null {
  if (value === undefined || value === null) return null;
  return requireFiniteNumber(value, field, context);
}

/**
 * An ISO-8601 instant.
 *
 * The grammar is intentionally permissive about the zone designator: the
 * report is rendered in the browser and the only thing that matters is
 * that the string IS an instant, not that it uses one particular offset.
 */
function requireInstant(value: unknown, field: string, context: string): string {
  const text = requireText(value, field, context);
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?)?(Z|[+-]\d{2}:?\d{2})?$/.test(text)) {
    fail(field, context, "must be an ISO-8601 instant");
  }
  if (!Number.isFinite(Date.parse(text))) {
    fail(field, context, "must be an ISO-8601 instant");
  }
  return text;
}

/** An optional instant. The KEY must exist; its value may be null. */
function optionalInstant(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  const value = requireKey(record, field, context);
  if (value === null) return null;
  return requireInstant(value, field, context);
}

/** A required `YYYY-MM-DD` calendar date. */
function requireCalendarDate(value: unknown, field: string, context: string): string {
  const text = requireText(value, field, context);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(field, context, "must be a YYYY-MM-DD date");
  return text;
}

function requireEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  context: string,
): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(field, context, `must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

/**
 * The source of one observation.
 *
 * The database stores `official`, `apify` or null. Null is UNKNOWN, never
 * `graph_own`: the owner's own account is a different population.
 */
function requireSourceField(
  record: Record<string, unknown>,
  field: string,
  context: string,
): CompetitorReportSource {
  const value = requireKey(record, field, context);
  if (value === null) return "unknown";
  if (value === "official" || value === "apify") return value;
  fail(field, context, "must be official, apify or absent");
}

const GROWTH_REASONS: readonly CompetitorReportGrowthReason[] = [
  "first_observation",
  "missing_baseline",
  "zero_baseline",
  "stale_baseline",
  "unavailable_metric",
  "source_changed",
  "baseline_policy_unset",
];

const WEEKLY_COVERAGES: readonly CompetitorReportWeeklyCoverage[] = [
  "complete",
  "partial",
  "unknown",
];

const OUTLIER_LABELS: readonly CompetitorReportOutlierLabel[] = [
  "outlier",
  "above",
  "normal",
  "below",
  "too_early",
  "no_data",
  "small_baseline",
];

const METRIC_BASES: readonly CompetitorReportMetricBasis[] = [
  "public_views",
  "public_interactions",
];

/* -------------------------------------------------------------------------- */
/* The readers                                                                   */
/* -------------------------------------------------------------------------- */

function readQuota(value: unknown, context: string): CompetitorReportQuota {
  const raw = requireRecord(value, context);
  const trackedActive = requireKey(raw, "tracked_active", context);
  if (trackedActive === null) {
    fail("tracked_active", context, "must be a number");
  }
  return {
    max_tracked_competitors: optionalCountField(
      raw,
      "max_tracked_competitors",
      context,
    ),
    unlimited: requireFlag(raw.unlimited, "unlimited", context),
    tracked_active: requireCount(trackedActive, "tracked_active", context),
    remaining: optionalCountField(raw, "remaining", context),
  };
}

/**
 * Reads a quota payload.
 *
 * The report envelope and the `read_own_competitor_quota()` RPC carry the
 * SAME four-key shape, so they share this one reader instead of growing
 * a second, subtly different one.
 */
export function parseCompetitorQuota(value: unknown): CompetitorReportQuota {
  return readQuota(value, "quota");
}

function readCursor(
  record: Record<string, unknown>,
  field: string,
  context: string,
): string | null {
  const value = requireKey(record, field, context);
  if (value === null) return null;
  if (typeof value !== "string") fail(field, context, "must be a string");
  if (value.length > COMPETITOR_REPORT_MAX_CURSOR_LENGTH) {
    fail(field, context, "is longer than the cursor bound");
  }
  return value;
}

function readProfile(
  value: unknown,
  context: string,
): CompetitorReportProfileObservation | null {
  if (value === undefined || value === null) return null;
  const raw = requireRecord(value, context);
  return {
    followers_count: optionalCountField(raw, "followers_count", context),
    media_count: optionalCountField(raw, "media_count", context),
    captured_at: requireInstant(raw.captured_at, "captured_at", context),
    captured_on: requireCalendarDate(raw.captured_on, "captured_on", context),
    source: requireSourceField(raw, "source", context),
  };
}

function readFreshness(value: unknown, context: string): CompetitorReportFreshness {
  const raw = requireRecord(value, context);
  return {
    last_capture_at: optionalInstant(raw, "last_capture_at", context),
    last_full_success_at: optionalInstant(raw, "last_full_success_at", context),
    last_partial_at: optionalInstant(raw, "last_partial_at", context),
    job_status: optionalTextField(raw, "job_status", context),
    reason_code: optionalTextField(raw, "reason_code", context),
  };
}

function readGrowth(value: unknown, context: string): CompetitorReportGrowth {
  const raw = requireRecord(value, context);
  const reason = requireKey(raw, "reason", context);
  return {
    absolute: optionalCountField(raw, "absolute", context),
    percent: optionalFiniteNumber(raw.percent, "percent", context),
    baseline_at: optionalInstant(raw, "baseline_at", context),
    observed_at: optionalInstant(raw, "observed_at", context),
    interval_days: optionalFiniteNumber(raw.interval_days, "interval_days", context),
    reason:
      reason === null
        ? null
        : requireEnum(reason, GROWTH_REASONS, "reason", context),
  };
}

function readWeekly(value: unknown, context: string): CompetitorReportWeekly {
  const raw = requireRecord(value, context);
  const observedCount = requireKey(raw, "observed_count", context);
  if (observedCount === null) {
    fail("observed_count", context, "must be a number");
  }
  return {
    observed_count: requireCount(observedCount, "observed_count", context),
    posts_per_week: optionalFiniteNumber(raw.posts_per_week, "posts_per_week", context),
    interval_start: optionalInstant(raw, "interval_start", context),
    interval_end: optionalInstant(raw, "interval_end", context),
    coverage: requireEnum(raw.coverage, WEEKLY_COVERAGES, "coverage", context),
    reason: optionalTextField(raw, "reason", context),
  };
}

function readEntry(value: unknown, context: string): CompetitorReportEntry {
  const raw = requireRecord(value, context);
  return {
    watchlist_id: requireText(raw.watchlist_id, "watchlist_id", context),
    username: requireText(raw.username, "username", context),
    label: optionalTextField(raw, "label", context),
    is_active: requireFlag(raw.is_active, "is_active", context),
    removed_at: optionalInstant(raw, "removed_at", context),
    status: requireText(raw.status, "status", context),
    last_error_code: optionalTextField(raw, "last_error_code", context),
    next_retry_at: optionalInstant(raw, "next_retry_at", context),
    cleanup_eligible_at: optionalInstant(raw, "cleanup_eligible_at", context),
    profile: readProfile(requireKey(raw, "profile", context), `${context}.profile`),
    freshness: readFreshness(raw.freshness, `${context}.freshness`),
    growth_7d: readGrowth(raw.growth_7d, `${context}.growth_7d`),
    growth_30d: readGrowth(raw.growth_30d, `${context}.growth_30d`),
    weekly: readWeekly(raw.weekly, `${context}.weekly`),
  };
}

function readOutlier(value: unknown, context: string): CompetitorReportOutlier {
  const raw = requireRecord(value, context);
  const baselineSize = requireKey(raw, "baselineSize", context);
  if (baselineSize === null) {
    fail("baselineSize", context, "must be a number");
  }
  const basis = requireKey(raw, "metric_basis", context);
  return {
    id: requireText(raw.id, "id", context),
    score: optionalFiniteNumber(raw.score, "score", context),
    label: requireEnum(raw.label, OUTLIER_LABELS, "label", context),
    baselineMedian: optionalFiniteNumber(raw.baselineMedian, "baselineMedian", context),
    baselineSize: requireCount(baselineSize, "baselineSize", context),
    metric_basis:
      basis === null
        ? null
        : requireEnum(basis, METRIC_BASES, "metric_basis", context),
    source: requireSourceField(raw, "source", context),
    reason: optionalTextField(raw, "reason", context),
  };
}

function readMedia(value: unknown, context: string): CompetitorReportMedia {
  const raw = requireRecord(value, context);
  return {
    ig_media_id: requireText(raw.ig_media_id, "ig_media_id", context),
    published_at: requireInstant(raw.published_at, "published_at", context),
    captured_at: requireInstant(raw.captured_at, "captured_at", context),
    media_product_type: optionalTextField(raw, "media_product_type", context),
    media_type: optionalTextField(raw, "media_type", context),
    thumbnail_url: optionalTextField(raw, "thumbnail_url", context),
    permalink: optionalTextField(raw, "permalink", context),
    caption: optionalTextField(raw, "caption", context),
    like_count: optionalCountField(raw, "like_count", context),
    comments_count: optionalCountField(raw, "comments_count", context),
    view_count: optionalCountField(raw, "view_count", context),
    source: requireSourceField(raw, "source", context),
    outlier: readOutlier(raw.outlier, `${context}.outlier`),
  };
}

/* -------------------------------------------------------------------------- */
/* The entry point                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Reads an untrusted report payload into the public DTO v1.
 *
 * @throws CompetitorReportContractError when the payload is not a report
 * this module understands.
 */
export function parseCompetitorReport(value: unknown): CompetitorReport {
  const raw = requireRecord(value, "report");

  const version = raw.version;
  if (version !== COMPETITOR_REPORT_SCHEMA_VERSION) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `report.version must be ${COMPETITOR_REPORT_SCHEMA_VERSION}`,
    );
  }

  const asOf = requireInstant(raw.as_of, "as_of", "report");
  const captureTimezone = requireText(raw.capture_timezone, "capture_timezone", "report");
  if (captureTimezone !== COMPETITOR_REPORT_CAPTURE_TIMEZONE) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "report.capture_timezone is not the expected capture timezone",
    );
  }

  const quota = readQuota(raw.quota, "report.quota");
  const nextCursor = readCursor(raw, "next_cursor", "report");

  const envelope = {
    version: COMPETITOR_REPORT_SCHEMA_VERSION,
    as_of: asOf,
    capture_timezone: COMPETITOR_REPORT_CAPTURE_TIMEZONE,
    quota,
    next_cursor: nextCursor,
  } as const;

  // The two envelopes are disjoint: a list carries `entries`, a detail
  // carries `entry` and `media`. A payload that carries BOTH is not a
  // report this module understands, and neither is one that carries
  // neither.
  const hasEntries = "entries" in raw;
  const hasDetail = "media" in raw || "entry" in raw;

  if (hasEntries && hasDetail) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      "the report carries a list and a detail at the same time",
    );
  }

  if (hasEntries) {
    const entries = requireArray(raw.entries, "entries", "report").map((row, index) =>
      readEntry(row, `entries[${index}]`),
    );
    return { ...envelope, entries };
  }

  if (hasDetail) {
    const detailEntry = requireKey(raw, "entry", "report");
    const media = requireArray(raw.media, "media", "report").map((row, index) =>
      readMedia(row, `media[${index}]`),
    );
    return {
      ...envelope,
      entry: detailEntry === null ? null : readEntry(detailEntry, "entry"),
      media,
    };
  }

  throw new CompetitorReportContractError(
    "REPORT_UNAVAILABLE",
    "the report carries neither entries nor media",
  );
}
