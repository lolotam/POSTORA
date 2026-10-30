/**
 * The frozen public contract of the competitor tracking report (DTO v1).
 *
 * WHAT THIS MODULE OWNS
 *
 *   1. The request contract of the new POST boundary.
 *   2. The public DTO v1 of spec §5 ("New read boundary and proposed DTO v1").
 *   3. The RAW projection the database reader hands over, and the pure
 *      validation of that untrusted projection.
 *   4. The closed set of client-facing error codes.
 *
 * WHAT IT DELIBERATELY DOES NOT OWN
 *
 *   * No growth arithmetic. `growth.ts` maps the SQL growth projection and
 *     owns the baseline policy.
 *   * No weekly arithmetic. `weeklyInventory.ts` owns the coverage proof.
 *   * No outlier arithmetic. `_shared/outlierScore.ts` owns the algorithm and
 *     the label vocabulary; this module only imports its TYPES (ARCHITECTURE
 *     §22 canonical contract rule).
 *   * No Deno APIs, no Supabase client, no fetch, no clock. The instant is a
 *     parameter and every row arrives as an argument, so the whole report is
 *     reproducible from its inputs.
 *
 * THE DTO v1 FIELD NAMES
 *
 *   §5 names the envelope and the entry fields in snake_case
 *   (`watchlist_id`, `as_of`, `next_cursor`, `observed_count`, ...) and names
 *   the canonical outlier object as `{id,score,label,baselineMedian,baselineSize}`
 *   - the exact shape of `OutlierResult` in `_shared/outlierScore.ts`. The
 *   outlier object therefore keeps that canonical spelling and adds the two
 *   feature-specific snake_case fields §5 lists next to it (`metric_basis`,
 *   `source`, `reason`). Nothing else renames a §5 field.
 *
 * THE GROWTH REASON VOCABULARY
 *
 *   §5 lists the public reasons: `first_observation`, `missing_baseline`,
 *   `zero_baseline`, `stale_baseline`, `unavailable_metric`, `source_changed`
 *   and `baseline_policy_unset`. The SQL reader names the same cases with its
 *   own vocabulary (`no_comparable_baseline` for the case §5 calls
 *   `missing_baseline`). `growth.ts` owns that translation; this module only
 *   declares the public side of it.
 */

import type { OutlierLabel } from "../_shared/outlierScore.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/** The version of the competitor tracking report DTO. */
export const COMPETITOR_REPORT_SCHEMA_VERSION = 1;

/** The capture timezone the report is expressed in. */
export const COMPETITOR_REPORT_CAPTURE_TIMEZONE = "Asia/Kuwait";

/** The default page size when the caller does not ask for one. */
export const COMPETITOR_REPORT_DEFAULT_LIMIT = 20;

/** The hard page-size ceiling. A report is never an unbounded history dump. */
export const COMPETITOR_REPORT_MAX_LIMIT = 50;

/** The hard cursor ceiling, in characters. */
export const COMPETITOR_REPORT_MAX_CURSOR_LENGTH = 2048;

/** The request body ceiling, in bytes. */
export const COMPETITOR_REPORT_MAX_BODY_BYTES = 4_096;

/** The whole request, counted from before the body is read. */
export const COMPETITOR_REPORT_TOTAL_BUDGET_MS = 15_000;

/** The ceiling of a single dependency: the body, the claims, the read. */
export const COMPETITOR_REPORT_DEPENDENCY_CEILING_MS = 5_000;

/** The reserve kept for the audit record and the response. */
export const COMPETITOR_REPORT_AUDIT_RESERVE_MS = 1_000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * The stable client-facing error codes. They are a CLOSED set (spec §5).
 *
 *   INVALID_REQUEST     the request itself is wrong (400, and 405/413)
 *   UNAUTHORIZED        no verified user, or a service credential (401/403)
 *   NOT_FOUND           no such entry of this owner (404)
 *   REPORT_UNAVAILABLE  the read failed or the upstream payload is broken
 */
export type CompetitorReportErrorCode =
  | "INVALID_REQUEST"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "REPORT_UNAVAILABLE";

/**
 * A typed refusal. Every expected failure of the report boundary is one of
 * these - never a thrown string, never a silent empty result
 * (ARCHITECTURE §32).
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
/* The request contract                                                         */
/* -------------------------------------------------------------------------- */

export type CompetitorReportState = "active" | "removed";

export type CompetitorReportPeriodDays = 7 | 30;

/**
 * The validated request.
 *
 * The two actions are a DISCRIMINATED UNION on purpose: a list carries no
 * watchlist id and no period, and a detail carries no state. The database
 * reader refuses the same shape, so the two agree on what a request is.
 */
export type CompetitorReportRequest =
  | {
    readonly action: "list";
    readonly state: CompetitorReportState;
    readonly limit: number;
    readonly cursor: string | null;
  }
  | {
    readonly action: "detail";
    readonly watchlistId: string;
    readonly periodDays: CompetitorReportPeriodDays;
    readonly limit: number;
    readonly cursor: string | null;
  };

/** The UUID shape the report accepts is enforced by the request schema. */

/* -------------------------------------------------------------------------- */
/* The public DTO                                                                */
/* -------------------------------------------------------------------------- */

/**
 * The source of one observation.
 *
 * The report only ever carries `official`, `apify` or `unknown`. The owner's
 * own `graph_own` source is a different population and is never mixed in.
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
 * A null output means UNAVAILABLE, never zero. The reason names which case
 * it is, so the UI never has to guess.
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
 * `observed_count` is the number of distinct observed posts inside the
 * displayed interval. `posts_per_week` is non-null ONLY when the coverage
 * proves the window: a partial or unknown window never carries an
 * extrapolated rate.
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
export type CompetitorReportOutlier = {
  id: string;
  score: number | null;
  label: OutlierLabel;
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
/* The raw projection                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The RAW projection the database reader hands over.
 *
 * It is NOT the public DTO: the SQL returns the columns, the assembler
 * decides what becomes public. Every field here is untrusted until it has
 * been validated.
 */
export type RawQuota = {
  max_tracked_competitors: number | null;
  unlimited: boolean;
  tracked_active: number;
  remaining: number | null;
};

export type RawProfileObservation = {
  followers_count: number | null;
  media_count: number | null;
  captured_at: string;
  captured_on: string;
  source: string | null;
};

export type RawCoverageRow = {
  captured_on: string;
  captured_at: string;
  source: string | null;
  job_generation: number | null;
  capture_started_at: string | null;
  capture_ended_at: string | null;
  oldest_returned_at: string | null;
  ordering_verified: boolean | null;
  cursor_present: boolean | null;
  exhausted: boolean | null;
  truncated: boolean | null;
  gap_reason: string | null;
};

export type RawJob = {
  status: string | null;
  job_generation: number | null;
  attempts: number | null;
  due_at: string | null;
  retry_at: string | null;
  last_attempt_at: string | null;
  last_partial_at: string | null;
  last_success_at: string | null;
  last_reason_code: string | null;
  captured_on: string | null;
};

export type RawGrowth = {
  period_days: number | null;
  reason: string | null;
  observed_at: string | null;
  observed_followers: number | null;
  observed_source: string | null;
  baseline_at: string | null;
  baseline_followers: number | null;
  interval_days: number | null;
  interval_seconds: number | null;
  absolute: number | null;
  percent: number | null;
};

export type RawEntry = {
  watchlist_id: string;
  username: string;
  label: string | null;
  is_active: boolean;
  removed_at: string | null;
  status: string;
  last_error_code: string | null;
  next_retry_at: string | null;
  source: string | null;
  cleanup_eligible_at: string | null;
  created_at: string | null;
  profile: RawProfileObservation | null;
  observations: unknown[];
  observations_truncated: boolean;
  growth: Record<string, RawGrowth>;
  coverage: RawCoverageRow[];
  coverage_truncated: boolean;
  job: RawJob | null;
};

export type RawBaselineCandidate = {
  ig_media_id: string;
  published_at: string;
  captured_at: string;
  source: string | null;
  metric_basis: string | null;
  value: number | null;
};

export type RawMedia = {
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
  source: string | null;
  metric_basis: string | null;
  mature: boolean;
  baseline: RawBaselineCandidate[];
  baseline_incomplete: boolean;
};

export type RawReportProjection = {
  version: number;
  action: string;
  as_of: string;
  capture_timezone: string;
  quota: RawQuota;
  next_cursor: string | null;
  entries: RawEntry[];
  entry: RawEntry | null;
  media: RawMedia[];
};

/* -------------------------------------------------------------------------- */
/* Primitive validators                                                          */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required, non-blank string. Returned unchanged - ids are identity. */
export function requireText(
  value: unknown,
  field: string,
  context: string,
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a non-empty string`,
    );
  }
  return value;
}

/** An optional string. A blank string is treated as absent. */
export function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/**
 * A COUNT. A count is a non-negative integer in the database, so a value that
 * is not a safe integer is a broken payload and the read fails closed.
 *
 * The transport must reject an unsafe conversion rather than silently round
 * it: a bigint beyond 2^53 does not survive JSON.parse exactly, and a
 * rounded follower count is a wrong follower count.
 */
export function readCount(value: unknown, field: string, context: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a safe integer`,
    );
  }
  return value;
}

/**
 * A MEASUREMENT that may be fractional (a percentage, a day count).
 *
 * A non-finite value is rejected: `NaN` and `Infinity` are not answers, and
 * they would silently become null on the way to the browser.
 */
export function readFiniteNumber(
  value: unknown,
  field: string,
  context: string,
): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a finite number`,
    );
  }
  return value;
}

/** A boolean flag. A non-boolean is refused rather than read as false. */
export function readFlag(value: unknown, field: string, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a boolean`,
    );
  }
  return value;
}

/** An optional boolean. Absent stays absent. */
export function readOptionalFlag(
  value: unknown,
  field: string,
  context: string,
): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "boolean") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a boolean`,
    );
  }
  return value;
}

/**
 * An ISO-8601 instant.
 *
 * The grammar mirrors `_shared/outlierScore.ts` on purpose: the report
 * boundary and the canonical scorer must agree on which strings are
 * instants, or a row could be placed in an interval by one and scored as
 * "no data" by the other.
 *
 * It is a THIRD copy of that grammar (the owner report in
 * `instagram-insights-report/contracts.ts` carries one), and it stays a copy
 * on purpose. The shared module cannot be imported for it without importing
 * the OWNER REPORT's error type into this boundary, and the owner report's
 * contract is frozen: this feature must not change it. The three copies
 * therefore carry the same grammar and each says why it exists.
 */
const ISO_INSTANT =
  /^(\d{4})-(\d{2})-(\d{2})(?:[Tt ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d+))?)?)?\s*(?:([Zz])|([+-])(\d{2})(?::?(\d{2}))?)?$/;

const MONTH_LENGTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  return month === 2 && isLeapYear(year) ? 29 : MONTH_LENGTHS[month - 1];
}

/**
 * An instant in epoch milliseconds.
 *
 * @throws CompetitorReportContractError when the string is not an instant.
 */
export function parseInstant(value: unknown, field: string, context: string): number {
  if (typeof value !== "string") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be an ISO-8601 instant`,
    );
  }
  const trimmed = value.trim();
  const match = ISO_INSTANT.exec(trimmed);
  if (!match) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be an ISO-8601 instant`,
    );
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a real calendar instant`,
    );
  }

  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined
    ? 0
    : Number(match[7].slice(0, 3).padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a real calendar instant`,
    );
  }

  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  let epoch = date.getTime();

  if (match[8] === undefined && match[9] === undefined) {
    // No zone designator: read as UTC so the result is host independent.
  } else if (match[8] !== undefined) {
    // "Z" - already UTC.
  } else {
    const sign = match[9] === "+" ? 1 : -1;
    const offsetHours = Number(match[10]);
    const offsetMinutes = match[11] === undefined ? 0 : Number(match[11]);
    if (offsetHours > 23 || offsetMinutes > 59) {
      throw new CompetitorReportContractError(
        "REPORT_UNAVAILABLE",
        `${context}.${field} has an invalid UTC offset`,
      );
    }
    epoch -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  if (!Number.isFinite(epoch)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a real calendar instant`,
    );
  }
  return epoch;
}

/** An optional instant, validated. Absent stays absent. */
export function readOptionalInstant(
  value: unknown,
  field: string,
  context: string,
): string | null {
  if (value === undefined || value === null) return null;
  const text = requireText(value, field, context);
  parseInstant(text, field, context);
  return text;
}

/** A `YYYY-MM-DD` calendar date. */
export function readCalendarDate(value: unknown, field: string, context: string): string {
  const text = requireText(value, field, context);
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!match) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a YYYY-MM-DD date`,
    );
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a YYYY-MM-DD date`,
    );
  }
  return text;
}

/**
 * The source of one observation.
 *
 * The database stores `official`, `apify` or null. Null is UNKNOWN, never
 * `graph_own`: the owner's own account is a different population.
 */
export function readSource(value: unknown, field: string, context: string): CompetitorReportSource {
  if (value === undefined || value === null) return "unknown";
  if (value === "official" || value === "apify") return value;
  throw new CompetitorReportContractError(
    "REPORT_UNAVAILABLE",
    `${context}.${field} must be official, apify or absent`,
  );
}

/**
 * A safe external URL.
 *
 * Only `http` and `https` are projected. A `javascript:` or `data:` URL is
 * dropped to null, and a URL that carries credentials in its authority is
 * dropped as well: the report is rendered in a browser.
 */
export function readSafeUrl(value: unknown, field: string, context: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a string`,
    );
  }
  const trimmed = value.trim();
  if (trimmed === "") return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (parsed.username !== "" || parsed.password !== "") return null;
  return parsed.toString();
}

/**
 * A caption is PLAIN third-party text.
 *
 * It is never HTML. Any markup the provider stored is removed here, so a
 * frontend that renders the caption as text can never be handed markup by
 * accident, and a frontend that renders it as HTML has nothing to render.
 */
export function readPlainCaption(value: unknown, field: string, context: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new CompetitorReportContractError(
      "REPORT_UNAVAILABLE",
      `${context}.${field} must be a string`,
    );
  }
  // Markup first, then the control characters that carry no meaning in a
  // caption. The text itself is preserved character for character.
  const plain = value
    .replace(/<[^>]*>/g, "")
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return plain;
}
