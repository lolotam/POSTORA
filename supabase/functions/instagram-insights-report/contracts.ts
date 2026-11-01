/**
 * Frozen owner-report contract for the Instagram insights report.
 *
 * Three things live here and nowhere else:
 *
 *   1. the report DTO (schema version 1) that the UI and the proxy read,
 *   2. the repository INPUT contract - what a reader must hand to the
 *      assembler, and what the reader must NOT do,
 *   3. explicit, pure validation of that untrusted input.
 *
 * The module is deliberately runtime-neutral: no Deno APIs, no Supabase
 * client, no fetch, no filesystem, no React, no clock. Everything that
 * depends on the outside world is injected - the instant is a parameter and
 * the rows are arguments. That is what lets the assembler be exercised
 * without a database, and it is what keeps ONE authoritative contract for
 * the report (ARCHITECTURE sections 22 and 31, plan section 5.4).
 *
 * The outlier types are imported from the canonical module, never redefined:
 * `_shared/outlierScore.ts` owns the algorithm and its label vocabulary.
 */

import type { OutlierFormat, OutlierLabel } from "../_shared/outlierScore.ts";

/* -------------------------------------------------------------------------- */
/* Constants                                                                    */
/* -------------------------------------------------------------------------- */

/** Version of the owner-report DTO. Bump on any breaking shape change. */
export const OWNER_REPORT_SCHEMA_VERSION = 1;

/** The only display periods the report accepts. */
export const OWNER_REPORT_PERIOD_DAYS = [7, 14, 30, 90] as const;

/** Default page size when the caller does not ask for one. */
export const OWNER_REPORT_DEFAULT_LIMIT = 20;

/** Hard page-size ceiling. A report is never an unbounded history dump. */
export const OWNER_REPORT_MAX_LIMIT = 100;

/**
 * The provider can lag behind a capture by up to 48 hours. The report
 * carries this as a stable code, not as prose: the UI translates it.
 */
export const OWNER_REPORT_LAG_NOTE = "provider_data_may_lag_up_to_48h";

export const MILLISECONDS_PER_DAY = 86_400_000;

/* -------------------------------------------------------------------------- */
/* Errors                                                                       */
/* -------------------------------------------------------------------------- */

export type OwnerReportErrorCode =
  | "INVALID_PERIOD"
  | "INVALID_LIMIT"
  | "INVALID_CURSOR"
  | "INVALID_SCOPE"
  | "INVALID_NOW"
  | "INVALID_INPUT"
  | "INVALID_ROW"
  | "ACCOUNT_MISMATCH"
  | "CONFLICTING_DUPLICATE_ROW"
  | "CONFLICTING_CAPTURE_IDENTITY";

/**
 * A typed refusal. Every expected failure of the report boundary is one of
 * these - never a thrown string, never a silent empty result
 * (ARCHITECTURE section 32).
 */
export class OwnerReportContractError extends Error {
  readonly code: OwnerReportErrorCode;

  constructor(code: OwnerReportErrorCode, message: string) {
    super(message);
    this.name = "OwnerReportContractError";
    this.code = code;
  }
}

/* -------------------------------------------------------------------------- */
/* Public DTO                                                                   */
/* -------------------------------------------------------------------------- */

export type OwnerReportPeriodDays = (typeof OWNER_REPORT_PERIOD_DAYS)[number];

export type OwnerReportLagNote = typeof OWNER_REPORT_LAG_NOTE;

/**
 * The owner scope the report was read for. It arrives from the verified
 * auth identity and the owned-account lookup - never from a request body.
 */
export type OwnerReportScope = {
  ownerId: string;
  socialAccountId: string;
  platform: "instagram";
};

/**
 * The only source an owner report can carry. The owner's own media comes
 * from the Graph API; competitor public counts (paid + organic) are a
 * different population and are never mixed into this report.
 */
export type OwnerReportSource = "graph_own";

/**
 * Opaque page position. The transport encodes it; the assembler only ever
 * sees the validated tuple. It is never an SQL fragment.
 */
export type OwnerReportCursor = {
  publishedAt: string;
  mediaId: string;
};

export type OwnerReportRequest = {
  periodDays: OwnerReportPeriodDays;
  limit: number;
  cursor: OwnerReportCursor | null;
};

/** The metric a cohort was scored on. Units are never mixed. */
export type OwnerReportMetricBasis = "views" | "reach" | "interactions";

/**
 * Row status, mirroring the snapshot tables' CHECK constraint. Only ok rows
 * carry measurements. Row-level unavailable means wholly unavailable; error
 * and pending are attempts. All three project null metrics, never stale values.
 */
export type OwnerReportRowStatus = "pending" | "ok" | "unavailable" | "error";

/** Sync-level status of the owner's collection state. */
export type OwnerReportSyncStatus = "ok" | "partial" | "error" | "never";

/** How much of the period the stored history actually covers. */
export type OwnerReportCoverage = "complete" | "partial" | "unknown";

/**
 * Typed reason codes. The report never carries a raw provider or database
 * error message, and never carries a credential.
 */
export type OwnerReportReasonCode =
  | "ok"
  | "never_synced"
  | "scope_missing"
  | "reauth_required"
  | "throttled"
  | "usage_limit_reached"
  | "provider_unavailable"
  | "provider_error"
  | "network_error"
  | "write_failed"
  | "inventory_truncated"
  | "baseline_history_incomplete"
  | "unknown";

export type OwnerReportEngagementRate = {
  /** Percent, or null when it cannot be computed. Never 0-as-unknown. */
  value: number | null;
  unit: "percent";
  denominatorMetric: "reach";
  numeratorMetrics: readonly ["likes", "comments", "saved", "shares"];
};

export type OwnerReportOutlier = {
  score: number | null;
  label: OutlierLabel;
  baselineMedian: number | null;
  baselineSize: number;
  /** The cohort this item was scored in, or null when it has no value. */
  metricBasis: OwnerReportMetricBasis | null;
};

export type OwnerReportMediaMetrics = {
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

export type OwnerReportMediaItem = {
  mediaId: string;
  postId: string | null;
  publishedAt: string;
  capturedAt: string;
  capturedOn: string;
  captureTimezone: string;
  format: OutlierFormat;
  mediaProductType: string | null;
  mediaType: string | null;
  permalink: string | null;
  thumbnailUrl: string | null;
  status: OwnerReportRowStatus;
  metrics: OwnerReportMediaMetrics;
  engagementRate: OwnerReportEngagementRate;
  outlier: OwnerReportOutlier;
};

export type OwnerReportMediaCoverage = {
  /** Media groups the assembler received (display window + baseline history). */
  received: number;
  /** Groups whose latest capture falls inside the display window. */
  inWindow: number;
  /** In-window media classified as a reel. */
  reel: number;
  /** In-window media classified as a non-reel. */
  nonReel: number;
  /** In-window media excluded because Stories are not supported in v1. */
  excludedStory: number;
  /** In-window media excluded because the product type is not analysable. */
  excludedUnsupported: number;
  /** In-window media excluded because the product type is unknown. */
  excludedUnknown: number;
  /** In-window media with no completed capture yet. */
  excludedNoCapture: number;
  /** Media published after the report instant. */
  excludedFuture: number;
};

export type OwnerReportMediaPage = {
  items: OwnerReportMediaItem[];
  limit: number;
  returned: number;
  hasMore: boolean;
  nextCursor: OwnerReportCursor | null;
};

export type OwnerReportDailyRow = {
  /** The calendar day this row describes. */
  metricDate: string;
  /** The provider's own bucket label. Recorded, never assumed equal. */
  providerDate: string;
  /** The provider window that produced the row, when it is known. */
  periodStart: string | null;
  periodEnd: string | null;
  providerTimezone: string | null;
  status: OwnerReportRowStatus;
  capturedAt: string;
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

export type OwnerReportProfileObservation = {
  observedAt: string;
  observedOn: string;
  captureTimezone: string;
  status: OwnerReportRowStatus;
  followersCount: number | null;
  mediaCount: number | null;
};

export type OwnerReportFreshness = {
  status: OwnerReportSyncStatus;
  /** Last attempt of any kind. A failed attempt moves this and nothing else. */
  lastAttemptAt: string | null;
  /**
   * Last successful COMPLETE sync. This is the report's synced_at: it is
   * NOT the newest snapshot capture and NOT the newest attempt.
   */
  lastSuccessAt: string | null;
  lastPartialAt: string | null;
  partial: boolean;
  truncated: boolean;
  retryAt: string | null;
  reason: OwnerReportReasonCode | null;
};

export type OwnerReportCompleteness = {
  /** False when the baseline history was capped and may be short. */
  baselineHistoryComplete: boolean;
  /** True when the inventory cap excluded older in-window media. */
  inventoryTruncated: boolean;
  coverage: OwnerReportCoverage;
  oldestMediaPublishedAt: string | null;
  newestMediaPublishedAt: string | null;
};

export type OwnerReport = {
  schemaVersion: typeof OWNER_REPORT_SCHEMA_VERSION;
  source: OwnerReportSource;
  scope: OwnerReportScope;
  /** The instant the report was assembled. */
  generatedAt: string;
  period: {
    days: OwnerReportPeriodDays;
    /** Display window, half-open on instants: [windowStart, windowEnd]. */
    windowStart: string;
    windowEnd: string;
    /** The metric dates the daily series covers, inclusive on both ends. */
    metricDateStart: string;
    metricDateEnd: string;
  };
  account: {
    /**
     * The account's metric days, as the provider reported them. The report
     * sums nothing here: a period "reach" built from daily buckets would
     * be a sum of daily reach, not unique people reached, and the report
     * must not present one as the other.
     */
    daily: OwnerReportDailyRow[];
    /** Point-in-time observations. Never a daily metric. */
    profiles: OwnerReportProfileObservation[];
    latestProfileObservation: OwnerReportProfileObservation | null;
  };
  media: {
    page: OwnerReportMediaPage;
    coverage: OwnerReportMediaCoverage;
  };
  freshness: OwnerReportFreshness;
  completeness: OwnerReportCompleteness;
  lagNote: OwnerReportLagNote;
};

/* -------------------------------------------------------------------------- */
/* Repository input contract                                                    */
/* -------------------------------------------------------------------------- */

/**
 * One row of `ig_media_insight_snapshots`, as the reader hands it over.
 *
 * `mediaId` is the `ig_media_id` column. The optional `ownerId` /
 * `socialAccountId` fields are the denormalised owner columns: when a
 * reader includes them the assembler re-checks them against the scope, so a
 * mis-scoped read is refused instead of mixed into the report.
 */
export type MediaSnapshotRow = {
  id: string;
  ownerId?: string | null;
  socialAccountId?: string | null;
  mediaId: string;
  postId?: string | null;
  publishedAt: string;
  capturedAt: string;
  capturedOn: string;
  captureTimezone: string;
  mediaProductType?: string | null;
  mediaType?: string | null;
  permalink?: string | null;
  thumbnailUrl?: string | null;
  status?: OwnerReportRowStatus | null;
  views?: number | null;
  reach?: number | null;
  likes?: number | null;
  comments?: number | null;
  saved?: number | null;
  shares?: number | null;
  totalInteractions?: number | null;
  follows?: number | null;
  profileVisits?: number | null;
  replies?: number | null;
  igReelsAvgWatchTimeMs?: number | null;
};

/** One row of `ig_account_insight_daily`. */
export type AccountDailyRow = {
  id: string;
  ownerId?: string | null;
  socialAccountId?: string | null;
  metricDate: string;
  providerDate: string;
  periodStart?: string | null;
  periodEnd?: string | null;
  providerTimezone?: string | null;
  status?: OwnerReportRowStatus | null;
  capturedAt: string;
  reach?: number | null;
  views?: number | null;
  accountsEngaged?: number | null;
  totalInteractions?: number | null;
  likes?: number | null;
  comments?: number | null;
  saves?: number | null;
  shares?: number | null;
  follows?: number | null;
  unfollows?: number | null;
};

/** One row of `ig_account_profile_observations`. */
export type ProfileObservationRow = {
  id: string;
  ownerId?: string | null;
  socialAccountId?: string | null;
  observedAt: string;
  observedOn: string;
  captureTimezone: string;
  status?: OwnerReportRowStatus | null;
  followersCount?: number | null;
  mediaCount?: number | null;
};

export type OwnerReportFreshnessInput = {
  status: OwnerReportSyncStatus;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  lastPartialAt: string | null;
  partial: boolean;
  truncated: boolean;
  retryAt: string | null;
  reason: OwnerReportReasonCode | null;
};

export type OwnerReportCompletenessInput = {
  baselineHistoryComplete: boolean;
  inventoryTruncated: boolean;
  coverage: OwnerReportCoverage;
  oldestMediaPublishedAt: string | null;
  newestMediaPublishedAt: string | null;
};

/**
 * Everything the assembler needs. The reader owns every obligation listed
 * here; the assembler owns none of them.
 *
 * 1. SCOPE. The reader must read exactly one owner's account. Tenancy is
 *    structural: the composite foreign keys bind every snapshot to an
 *    account of the same owner, and RLS is not the boundary. When a row
 *    carries `ownerId` / `socialAccountId`, the assembler re-checks them
 *    and refuses a mismatch. Rows of a second account are never merged.
 *
 * 2. FAILURES ARE FAILURES. A failed read must throw at the reader. It must
 *    not become an empty array: an empty array and "no data yet" are
 *    different states, and only the reader can tell them apart.
 *
 * 3. BASELINE HISTORY IS INDEPENDENT OF THE DISPLAY PERIOD. `baselineHistory`
 *    is the media inventory the baseline is computed from, and it is read
 *    WITHOUT a display-period filter: the reader returns the SAME rows for
 *    every requested period. It must cover every media that `mediaSnapshots`
 *    contains, so the cohort the assembler scores is identical for a 7 day
 *    window and for a 90 day one. Narrowing the history with the display
 *    period - or returning a display row the history does not contain -
 *    makes the score depend on the requested period, which it must never do.
 *    The baseline is computed from strictly earlier, mature items of the
 *    same account, source, metric basis and format, so choosing a 7 day
 *    window must never shrink it. A reader that narrows the history with
 *    the display period breaks the scores.
 *
 * 4. LATEST SNAPSHOT PER MEDIA. The reader hands over the captures it read;
 *    the assembler selects the latest completed capture per media itself.
 *    Historical captures of the same media must be included, otherwise the
 *    baseline would be built from snapshot rows instead of from media. A
 *    capture that failed is an attempt, not a capture: it must not replace
 *    an earlier successful capture of the same media.
 *
 * 5. ACCOUNT DAYS. `accountDaily` must be read for the period's metric
 *    dates. The provider's own day label is carried through as
 *    `providerDate` and is never re-derived or relabelled. A metric date
 *    row is never populated with a follower count. Failed/pending attempts
 *    cannot replace a completed daily capture; an explicit unavailable
 *    capture may replace it with null measurements.
 *
 * 6. PROFILES ARE OBSERVATIONS. `profileObservations` are point-in-time
 *    follower / media-count reads. They are not metric days and must not be
 *    copied into the daily series. History retains failed/pending attempts,
 *    but latestProfileObservation selects only ok/unavailable observations
 *    and is null when no completed observation exists.
 *
 * 7. FRESHNESS COMES FROM THE AUTHORITATIVE SYNC STATE, not from a
 *    compatibility mirror in account metadata. `lastSuccessAt` is the last
 *    successful COMPLETE sync; a failed attempt advances `lastAttemptAt`
 *    and nothing else.
 *
 * 8. CONSISTENT READS. The display rows and the baseline history are read
 *    from the same snapshot tables. If a capture is overwritten between the
 *    two reads the assembler sees two contradictory rows for one capture
 *    day and refuses the input, which is the intended outcome: a reader
 *    that cannot see a consistent snapshot must not pretend it did.
 *
 * Timestamp identity uses canonical UTC spelling, preserving every supplied
 * fractional digit accepted by parseInstant (including PostgreSQL microseconds).
 * Equivalent offsets and trailing fractional zeros identify the same capture.
 * Capture selection and pagination retain sub-millisecond ordering; canonical
 * outlier scoring and display-window arithmetic retain their millisecond clock.
 * Provider day labels and timezone metadata are not relabelled by normalization.
 * The reader must explicitly supply persisted statuses and bound profile history;
 * a bounded media page does not bound the independent observation series.
 */
export type OwnerReportAssemblyInput = {
  scope: OwnerReportScope;
  now: Date;
  request: OwnerReportRequest;
  /**
   * The media rows the reader read for the display: every capture of the
   * media whose publication falls in the requested window. The assembler
   * filters them by `publishedAt` again, so a captured_on filter can never
   * decide what the report shows.
   */
  mediaSnapshots: readonly MediaSnapshotRow[];
  /**
   * The period-independent media inventory the baseline is computed from.
   * The same rows for every display period.
   */
  baselineHistory: readonly MediaSnapshotRow[];
  accountDaily: readonly AccountDailyRow[];
  profileObservations: readonly ProfileObservationRow[];
  freshness: OwnerReportFreshnessInput;
  completeness: OwnerReportCompletenessInput;
};

/* -------------------------------------------------------------------------- */
/* Primitive validators (exported for the assembler)                           */
/* -------------------------------------------------------------------------- */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A required, non-blank string. Returned unchanged - ids are identity. */
export function requireText(
  value: unknown,
  field: string,
  context: string,
  code: OwnerReportErrorCode = "INVALID_ROW",
): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new OwnerReportContractError(code, `${context}.${field} must be a non-empty string`);
  }
  return value;
}

/** An optional string. A blank string is treated as absent. */
export function optionalText(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return value.trim() === "" ? null : value;
}

/**
 * A metric. `null` means unavailable - never zero.
 *
 * A value that is not a number, is not finite, or is negative is
 * unavailable rather than an error: a provider that reports a negative or a
 * broken number has reported nothing usable, and the report must say so
 * instead of inventing a measurement (global constraint 5).
 */
export function readMetric(value: unknown): number | null {
  if (typeof value !== "number") return null;
  if (!Number.isFinite(value)) return null;
  if (value < 0) return null;
  return value;
}

/**
 * ISO-8601 calendar date with an optional time and an optional numeric zone
 * or `Z`. A zone-less instant is read as UTC.
 *
 * The grammar mirrors `_shared/outlierScore.ts` on purpose: the report
 * boundary and the canonical scorer must agree on which strings are
 * instants, or a row could be placed in the display window by one and
 * scored as "no data" by the other. Prose and slash dates are rejected
 * rather than parsed.
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

/** True for a real `YYYY-MM-DD` calendar date. */
export function isCalendarDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12) return false;
  return day >= 1 && day <= daysInMonth(year, month);
}

/**
 * An instant in epoch milliseconds.
 *
 * @throws OwnerReportContractError when the string is not an instant.
 */
export function parseInstant(
  value: unknown,
  field: string,
  context: string,
  code: OwnerReportErrorCode = "INVALID_ROW",
): number {
  if (typeof value !== "string") {
    throw new OwnerReportContractError(code, `${context}.${field} must be an ISO-8601 instant`);
  }
  const trimmed = value.trim();
  const match = ISO_INSTANT.exec(trimmed);
  if (!match) {
    throw new OwnerReportContractError(code, `${context}.${field} must be an ISO-8601 instant`);
  }

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) {
    throw new OwnerReportContractError(code, `${context}.${field} is not a real calendar instant`);
  }

  const hour = match[4] === undefined ? 0 : Number(match[4]);
  const minute = match[5] === undefined ? 0 : Number(match[5]);
  const second = match[6] === undefined ? 0 : Number(match[6]);
  const millisecond = match[7] === undefined
    ? 0
    : Number(match[7].slice(0, 3).padEnd(3, "0"));
  if (hour > 23 || minute > 59 || second > 59) {
    throw new OwnerReportContractError(code, `${context}.${field} is not a real calendar instant`);
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
      throw new OwnerReportContractError(code, `${context}.${field} has an invalid UTC offset`);
    }
    epoch -= sign * (offsetHours * 60 + offsetMinutes) * 60_000;
  }

  if (!Number.isFinite(epoch)) {
    throw new OwnerReportContractError(code, `${context}.${field} is not a real calendar instant`);
  }
  return epoch;
}

/** `YYYY-MM-DD` in UTC for an epoch instant. */
export function utcDateString(epochMs: number): string {
  const date = new Date(epochMs);
  const year = String(date.getUTCFullYear()).padStart(4, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** A `YYYY-MM-DD` date shifted by whole days. */
export function addUtcDays(dateString: string, days: number): string {
  const [year, month, day] = dateString.split("-").map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCDate(date.getUTCDate() + days);
  return utcDateString(date.getTime());
}

/* -------------------------------------------------------------------------- */
/* Transport boundary                                                           */
/* -------------------------------------------------------------------------- */

/** The validated display period. Anything else is refused. */
export function parseOwnerReportPeriod(value: unknown): OwnerReportPeriodDays {
  const numeric = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (!isReportPeriod(numeric)) {
    throw new OwnerReportContractError(
      "INVALID_PERIOD",
      `period must be one of ${OWNER_REPORT_PERIOD_DAYS.join(", ")}`,
    );
  }
  return numeric;
}

function isReportPeriod(value: unknown): value is OwnerReportPeriodDays {
  return OWNER_REPORT_PERIOD_DAYS.some((period) => period === value);
}

/** A bounded page size. */
export function parseOwnerReportLimit(value: unknown): number {
  if (value === undefined || value === null) return OWNER_REPORT_DEFAULT_LIMIT;
  const numeric = typeof value === "string" && /^\d+$/.test(value.trim())
    ? Number(value.trim())
    : value;
  if (
    typeof numeric !== "number" ||
    !Number.isInteger(numeric) ||
    numeric < 1 ||
    numeric > OWNER_REPORT_MAX_LIMIT
  ) {
    throw new OwnerReportContractError(
      "INVALID_LIMIT",
      `limit must be an integer between 1 and ${OWNER_REPORT_MAX_LIMIT}`,
    );
  }
  return numeric;
}

/** The validated cursor tuple. `null` means "first page". */
export function parseOwnerReportCursor(value: unknown): OwnerReportCursor | null {
  if (value === undefined || value === null) return null;
  if (!isRecord(value)) {
    throw new OwnerReportContractError("INVALID_CURSOR", "cursor must be an object");
  }
  const publishedAt = requireText(value.publishedAt, "publishedAt", "cursor", "INVALID_CURSOR");
  const mediaId = requireText(value.mediaId, "mediaId", "cursor", "INVALID_CURSOR");
  parseInstant(publishedAt, "publishedAt", "cursor", "INVALID_CURSOR");
  return { publishedAt, mediaId };
}

/** HTTP cursors may be tuples, JSON strings or legacy base64 JSON strings. */
export function decodeOwnerReportCursor(raw: unknown): OwnerReportCursor | null {
  if (raw === "") return null;
  if (typeof raw !== "string") return parseOwnerReportCursor(raw);
  let decoded: unknown;
  try {
    decoded = JSON.parse(raw);
  } catch {
    try {
      decoded = JSON.parse(atob(raw));
    } catch {
      throw new OwnerReportContractError("INVALID_CURSOR", "cursor must be a valid cursor object or encoded string");
    }
  }
  const cursor = parseOwnerReportCursor(decoded);
  if (!cursor) throw new OwnerReportContractError("INVALID_CURSOR", "encoded cursor must contain a cursor tuple");
  return cursor;
}

/** The validated scope. */
export function parseOwnerReportScope(value: unknown): OwnerReportScope {
  if (!isRecord(value)) {
    throw new OwnerReportContractError("INVALID_SCOPE", "scope must be an object");
  }
  const ownerId = requireText(value.ownerId, "ownerId", "scope", "INVALID_SCOPE");
  const socialAccountId = requireText(
    value.socialAccountId,
    "socialAccountId",
    "scope",
    "INVALID_SCOPE",
  );
  const platform = value.platform === undefined ? "instagram" : value.platform;
  if (platform !== "instagram") {
    throw new OwnerReportContractError("INVALID_SCOPE", "scope.platform must be instagram");
  }
  return { ownerId, socialAccountId, platform };
}

/** The validated request: period, bounded limit and cursor. */
export function parseOwnerReportRequest(value: unknown): OwnerReportRequest {
  if (!isRecord(value)) {
    throw new OwnerReportContractError("INVALID_INPUT", "request must be an object");
  }
  return {
    periodDays: parseOwnerReportPeriod(value.periodDays ?? value.period_days),
    limit: parseOwnerReportLimit(value.limit),
    cursor: parseOwnerReportCursor(value.cursor),
  };
}
