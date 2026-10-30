/**
 * Strict parsers for the database receipts the competitor collector reads.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The exact shapes of the accepted SQL projections, and the rule that a
 *   receipt must agree with the request that produced it. A parser returns
 *   `null` for anything that is not exactly the documented projection; the
 *   store turns that into an indeterminate failure. Nothing here invents a
 *   default: a malformed status is never "none", a malformed result is never
 *   "completed".
 *
 * WHY OWN DATA DESCRIPTORS
 *
 *   An inherited value is not authority and an accessor is code this
 *   contract did not ask to run. Both read as absent.
 */

import type {
  CompetitorCoverageGapReason,
  CompetitorOutcome,
  CompetitorReasonCode,
  CompetitorResultPayload,
  CompetitorSource,
  EnqueueReceipt,
  OwnerStatusProjection,
  PersistResultReceipt,
  PersistedCompetitorCoverage,
} from "./types.ts";

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}(?::\d{2})?)$/;
const REASON_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The accepted throttle window is fifteen minutes. */
const MAX_RETRY_AFTER_SECONDS = 900;

const JOB_STATUSES = [
  "queued",
  "leased",
  "retry",
  "partial",
  "completed",
  "unavailable",
  "error",
] as const;

const ENQUEUE_ACCEPTED_KEYS = [
  "accepted",
  "reason",
  "job_id",
  "job_generation",
  "status",
  "captured_on",
  "created",
  "accepted_at",
];
const ENQUEUE_THROTTLED_KEYS = ["accepted", "reason", "retry_after_seconds", "captured_on"];

const STATUS_SHARED_KEYS = [
  "target_kind",
  "target_id",
  "captured_on",
  "status",
  "job_generation",
  "attempts",
  "due_at",
  "next_retry_at",
  "last_attempt_at",
  "last_partial_at",
  "last_success_at",
  "reason_code",
  "inventory",
];
const STATUS_JOB_KEYS = [...STATUS_SHARED_KEYS, "pending_operations"];
const INVENTORY_KEYS = [
  "truncated",
  "partial",
  "window_covered",
  "oldest_returned_at",
  "gap_reason",
  "pages_fetched",
];

const RESULT_COMPLETED_KEYS = [
  "job_id",
  "job_generation",
  "outcome",
  "source",
  "watchlist_id",
  "captured_on",
  "written",
  "media_count",
  "captured_at",
];
const RESULT_FAILED_KEYS = [
  "job_id",
  "job_generation",
  "outcome",
  "reason_code",
  "watchlist_id",
  "next_retry_at",
];

// The v2 receipt. The `version` key is what separates it from a v1
// receipt: a receipt without it, or with another number, is not a v2
// success and is never read as one.
const RESULT_V2_COMPLETED_KEYS = [
  "version",
  "job_id",
  "job_generation",
  "outcome",
  "source",
  "watchlist_id",
  "captured_on",
  "written",
  "media_count",
  "captured_at",
  "coverage",
];
const RESULT_V2_FAILED_KEYS = [
  "version",
  "job_id",
  "job_generation",
  "outcome",
  "reason_code",
  "watchlist_id",
  "next_retry_at",
];
const COVERAGE_KEYS = [
  "watchlist_id",
  "user_id",
  "captured_on",
  "captured_at",
  "source",
  "job_generation",
  "capture_started_at",
  "capture_ended_at",
  "oldest_returned_at",
  "ordering_verified",
  "cursor_present",
  "exhausted",
  "truncated",
  "gap_reason",
  "inventory_complete",
];

const THROTTLE_GLOBAL_KEYS = ["bucket_key", "usage_percent", "throttled_until", "job_id"];
const THROTTLE_PARKED_KEYS = [...THROTTLE_GLOBAL_KEYS, "status"];

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

export function readOwnData(
  record: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  if (!Object.hasOwn(record, key)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return { present: false, value: undefined };
  return { present: true, value: descriptor.value };
}

function hasExactKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const own = Reflect.ownKeys(record);
  if (own.length !== keys.length) return false;
  return keys.every((key) => readOwnData(record, key).present);
}

export function isUuidText(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

function isDate(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

function isTimestamp(value: unknown): value is string {
  return typeof value === "string" && TIMESTAMP_PATTERN.test(value) &&
    !Number.isNaN(new Date(value).getTime());
}

function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestamp(value);
}

function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNullableBoolean(value: unknown): value is boolean | null {
  return value === null || isBoolean(value);
}

/**
 * Whether two timestamps are the SAME INSTANT.
 *
 * The database renders an instant in its own canonical form and the
 * collector submits it in its own, so the two strings are not always
 * byte-identical even when they name the same moment. The comparison is
 * therefore on the instant, not on the text: '2026-10-29T02:00:00+00:00'
 * and '2026-10-29T02:00:00.000Z' are the same moment, and
 * '2026-10-29T02:00:01.000Z' is not.
 */
function isSameInstant(left: unknown, right: unknown): boolean {
  if (left === null || right === null) return left === right;
  if (typeof left !== "string" || typeof right !== "string") return false;
  const a = Date.parse(left);
  const b = Date.parse(right);
  return Number.isFinite(a) && Number.isFinite(b) && a === b;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return isNonNegativeSafeInteger(value) && value > 0;
}

function isJobStatus(value: unknown): value is (typeof JOB_STATUSES)[number] {
  return typeof value === "string" && (JOB_STATUSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The owner enqueue receipt
// ---------------------------------------------------------------------------

export function parseEnqueueReceipt(
  value: unknown,
  mode: "normal" | "force",
): EnqueueReceipt | null {
  if (!isPlainRecord(value)) return null;
  const accepted = readOwnData(value, "accepted");
  if (!accepted.present) return null;

  if (accepted.value === false) {
    if (!hasExactKeys(value, ENQUEUE_THROTTLED_KEYS)) return null;
    if (readOwnData(value, "reason").value !== "throttled") return null;
    const retryAfter = readOwnData(value, "retry_after_seconds").value;
    if (!isNonNegativeSafeInteger(retryAfter) || retryAfter > MAX_RETRY_AFTER_SECONDS) {
      return null;
    }
    const capturedOn = readOwnData(value, "captured_on").value;
    if (!isDate(capturedOn)) return null;
    return {
      accepted: false,
      reason: "throttled",
      jobId: null,
      jobGeneration: null,
      status: null,
      capturedOn,
      retryAfterSeconds: retryAfter,
    };
  }

  if (accepted.value !== true || !hasExactKeys(value, ENQUEUE_ACCEPTED_KEYS)) return null;

  const reason = readOwnData(value, "reason").value;
  if (reason !== "enqueued" && reason !== "already_enqueued" && reason !== "forced") {
    return null;
  }
  if (mode === "force" && reason !== "forced") return null;
  if (mode === "normal" && reason === "forced") return null;

  const created = readOwnData(value, "created").value;
  if (typeof created !== "boolean") return null;
  if (reason === "enqueued" && created !== true) return null;
  if (reason === "already_enqueued" && created !== false) return null;

  const jobId = readOwnData(value, "job_id").value;
  const jobGeneration = readOwnData(value, "job_generation").value;
  const status = readOwnData(value, "status").value;
  const capturedOn = readOwnData(value, "captured_on").value;
  const acceptedAt = readOwnData(value, "accepted_at").value;

  if (!isUuidText(jobId) || !isPositiveSafeInteger(jobGeneration)) return null;
  if (!isJobStatus(status)) return null;
  if ((reason === "enqueued" || reason === "forced") && status !== "queued") return null;
  if (!isDate(capturedOn) || !isTimestamp(acceptedAt)) return null;

  return {
    accepted: true,
    reason,
    jobId: jobId.toLowerCase(),
    jobGeneration,
    status,
    capturedOn,
    retryAfterSeconds: null,
  };
}

// ---------------------------------------------------------------------------
// The owner status projection
// ---------------------------------------------------------------------------

function isInventory(value: unknown, noJob: boolean): boolean {
  if (!isPlainRecord(value) || !hasExactKeys(value, INVENTORY_KEYS)) return false;
  const read = (key: string) => readOwnData(value, key).value;
  for (const key of ["truncated", "partial", "window_covered"]) {
    if (typeof read(key) !== "boolean") return false;
    if (noJob && read(key) !== false) return false;
  }
  if (!isNullableTimestamp(read("oldest_returned_at"))) return false;
  const gap = read("gap_reason");
  if (gap !== null && !isReasonCode(gap)) return false;
  if (!isNonNegativeSafeInteger(read("pages_fetched"))) return false;
  if (noJob) {
    return read("oldest_returned_at") === null && gap === null && read("pages_fetched") === 0;
  }
  return true;
}

/**
 * Parses the status projection and checks it against the request.
 *
 * The no-job variant (`status: "none"`) has thirteen keys; an actual job has
 * fourteen. Only the no-job variant may carry the zero generation and the
 * empty times.
 */
export function parseOwnerStatus(
  value: unknown,
  requestedTargetId: string,
  requestedCapturedOn: string | null,
): OwnerStatusProjection | null {
  if (!isPlainRecord(value)) return null;
  const status = readOwnData(value, "status");
  if (!status.present) return null;
  const noJob = status.value === "none";
  if (!noJob && !isJobStatus(status.value)) return null;
  if (!hasExactKeys(value, noJob ? STATUS_SHARED_KEYS : STATUS_JOB_KEYS)) return null;

  const read = (key: string) => readOwnData(value, key).value;

  if (read("target_kind") !== "competitor") return null;
  const targetId = read("target_id");
  if (!isUuidText(targetId) || !sameUuid(targetId, requestedTargetId)) return null;

  const capturedOn = read("captured_on");
  if (!isDate(capturedOn)) return null;
  if (requestedCapturedOn !== null && capturedOn !== requestedCapturedOn) return null;

  const jobGeneration = read("job_generation");
  const attempts = read("attempts");
  if (!isNonNegativeSafeInteger(jobGeneration) || !isNonNegativeSafeInteger(attempts)) {
    return null;
  }

  const times = ["due_at", "next_retry_at", "last_attempt_at", "last_partial_at", "last_success_at"];
  for (const key of times) {
    if (!isNullableTimestamp(read(key))) return null;
  }
  const reasonCode = read("reason_code");
  if (reasonCode !== null && !isReasonCode(reasonCode)) return null;
  if (!isInventory(read("inventory"), noJob)) return null;

  if (noJob) {
    if (jobGeneration !== 0 || attempts !== 0 || reasonCode !== null) return null;
    if (times.some((key) => read(key) !== null)) return null;
  } else {
    if (!isPositiveSafeInteger(jobGeneration) || !isTimestamp(read("due_at"))) return null;
    if (!isNonNegativeSafeInteger(read("pending_operations"))) return null;
  }

  return {
    targetKind: "competitor",
    targetId: targetId.toLowerCase(),
    capturedOn,
    status: status.value as string,
    jobGeneration,
    attempts,
    dueAt: read("due_at") as string | null,
    nextRetryAt: read("next_retry_at") as string | null,
    lastAttemptAt: read("last_attempt_at") as string | null,
    lastSuccessAt: read("last_success_at") as string | null,
    reasonCode: reasonCode as string | null,
    pendingOperations: noJob ? 0 : read("pending_operations") as number,
  };
}

// ---------------------------------------------------------------------------
// The atomic result receipt
// ---------------------------------------------------------------------------

/**
 * Parses the result receipt and binds it to the request.
 *
 * The receipt must name the same job and generation, the outcome the
 * payload asked for, and - for a capture - the same source, exactly one
 * profile plus every submitted media row, and a real capture instant. A
 * receipt that disagrees is not evidence the write happened as asked.
 *
 * This is the v1 receipt. It stays here because the v1 writer is still
 * callable; the collector itself writes through the v2 receipt below.
 */
export function parseResultReceipt(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly payload: CompetitorResultPayload;
  },
): PersistResultReceipt | null {
  if (!isPlainRecord(value)) return null;
  const read = (key: string) => readOwnData(value, key).value;
  const { payload } = request;

  const outcome = read("outcome");
  if (outcome !== payload.outcome) return null;

  const jobId = read("job_id");
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;
  if (read("job_generation") !== request.jobGeneration) return null;
  if (!isUuidText(read("watchlist_id"))) return null;

  if (outcome === "completed") {
    if (!hasExactKeys(value, RESULT_COMPLETED_KEYS)) return null;
    const source = read("source");
    if (source !== payload.source) return null;
    const mediaCount = payload.media?.length ?? -1;
    if (read("media_count") !== mediaCount) return null;
    if (read("written") !== mediaCount + 1) return null;
    if (!isDate(read("captured_on"))) return null;
    const capturedAt = read("captured_at");
    if (!isTimestamp(capturedAt)) return null;
    return {
      outcome: "completed",
      source: source as CompetitorSource,
      reasonCode: null,
      written: mediaCount + 1,
      mediaCount,
      capturedAt,
      coverage: null,
    };
  }

  if (!hasExactKeys(value, RESULT_FAILED_KEYS)) return null;
  const reasonCode = read("reason_code");
  if (reasonCode !== payload.reason_code) return null;
  if (!isTimestamp(read("next_retry_at"))) return null;
  return {
    outcome: outcome as CompetitorOutcome,
    source: null,
    reasonCode: reasonCode as CompetitorReasonCode,
    written: 0,
    mediaCount: 0,
    capturedAt: null,
    coverage: null,
  };
}

// ---------------------------------------------------------------------------
// The versioned (v2) result receipt
// ---------------------------------------------------------------------------

/**
 * Parses the coverage the database stored and binds it to the request.
 *
 * The receipt reports the STORED row, and the stored row has to answer for
 * the request: the same watchlist entry, the same capture day, the same
 * source, the same generation and the same evidence that was submitted. A
 * receipt that reports something else is not evidence that the write
 * happened as asked, so it is refused.
 */
function parseCoverage(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly payload: CompetitorResultPayload;
    readonly watchlistId: string;
    readonly capturedOn: string;
    readonly source: CompetitorSource;
  },
): PersistedCompetitorCoverage | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, COVERAGE_KEYS)) return null;

  const read = (key: string) => readOwnData(value, key).value;
  const submitted = request.payload.coverage;
  if (!submitted) return null;

  const watchlistId = read("watchlist_id");
  if (!isUuidText(watchlistId) || !sameUuid(watchlistId, request.watchlistId)) return null;
  if (!isUuidText(read("user_id"))) return null;

  const capturedOn = read("captured_on");
  if (!isDate(capturedOn) || capturedOn !== request.capturedOn) return null;
  if (!isTimestamp(read("captured_at"))) return null;

  const source = read("source");
  if (source !== request.source) return null;
  if (read("job_generation") !== request.jobGeneration) return null;

  const captureStartedAt = read("capture_started_at");
  if (!isTimestamp(captureStartedAt)) return null;
  if (!isSameInstant(captureStartedAt, submitted.capture_started_at)) return null;

  const captureEndedAt = read("capture_ended_at");
  if (!isTimestamp(captureEndedAt)) return null;
  if (!isSameInstant(captureEndedAt, submitted.capture_ended_at)) return null;

  const oldestReturnedAt = read("oldest_returned_at");
  if (!isNullableTimestamp(oldestReturnedAt)) return null;
  if (!isSameInstant(oldestReturnedAt, submitted.oldest_returned_at)) return null;

  const orderingVerified = read("ordering_verified");
  if (!isBoolean(orderingVerified)) return null;
  if (orderingVerified !== submitted.ordering_verified) return null;

  const cursorPresent = read("cursor_present");
  if (!isNullableBoolean(cursorPresent)) return null;
  if (cursorPresent !== submitted.cursor_present) return null;

  const exhausted = read("exhausted");
  if (!isBoolean(exhausted)) return null;
  if (exhausted !== submitted.exhausted) return null;

  const truncated = read("truncated");
  if (!isBoolean(truncated)) return null;
  if (truncated !== submitted.truncated) return null;

  const gapReason = read("gap_reason");
  if (gapReason !== null && !isReasonCode(gapReason)) return null;
  if (gapReason !== submitted.gap_reason) return null;

  // The derived verdict is not a free value: it is exactly "the walk
  // reached the end of the feed and nothing was capped".
  const inventoryComplete = read("inventory_complete");
  if (!isBoolean(inventoryComplete)) return null;
  if (inventoryComplete !== (exhausted && !truncated && gapReason === null)) return null;

  return {
    watchlistId: watchlistId.toLowerCase(),
    userId: (read("user_id") as string).toLowerCase(),
    capturedOn,
    capturedAt: read("captured_at") as string,
    source: source as CompetitorSource,
    jobGeneration: request.jobGeneration,
    captureStartedAt,
    captureEndedAt,
    oldestReturnedAt,
    orderingVerified,
    cursorPresent,
    exhausted,
    truncated,
    gapReason: gapReason as CompetitorCoverageGapReason | null,
    inventoryComplete,
  };
}

/**
 * Parses the v2 result receipt and binds it to the request.
 *
 * The receipt must carry `version = 2`. A v1 receipt has no version key at
 * all, so it can never be read as a v2 success, and a receipt with another
 * version is a contract this store does not know.
 */
export function parseCoverageResultReceipt(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly payload: CompetitorResultPayload;
  },
): PersistResultReceipt | null {
  if (!isPlainRecord(value)) return null;
  const read = (key: string) => readOwnData(value, key).value;
  const { payload } = request;

  if (read("version") !== 2) return null;

  const outcome = read("outcome");
  if (outcome !== payload.outcome) return null;

  const jobId = read("job_id");
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;
  if (read("job_generation") !== request.jobGeneration) return null;

  const watchlistId = read("watchlist_id");
  if (!isUuidText(watchlistId)) return null;

  if (outcome === "completed") {
    if (!hasExactKeys(value, RESULT_V2_COMPLETED_KEYS)) return null;

    const source = read("source");
    if (source !== payload.source) return null;

    const mediaCount = payload.media?.length ?? -1;
    if (read("media_count") !== mediaCount) return null;
    if (read("written") !== mediaCount + 1) return null;

    const capturedOn = read("captured_on");
    if (!isDate(capturedOn)) return null;

    const capturedAt = read("captured_at");
    if (!isTimestamp(capturedAt)) return null;

    const coverage = parseCoverage(read("coverage"), {
      jobId: request.jobId,
      jobGeneration: request.jobGeneration,
      payload,
      watchlistId,
      capturedOn,
      source: source as CompetitorSource,
    });
    if (coverage === null) return null;

    return {
      outcome: "completed",
      source: source as CompetitorSource,
      reasonCode: null,
      written: mediaCount + 1,
      mediaCount,
      capturedAt,
      coverage,
    };
  }

  if (!hasExactKeys(value, RESULT_V2_FAILED_KEYS)) return null;
  const reasonCode = read("reason_code");
  if (reasonCode !== payload.reason_code) return null;
  if (!isTimestamp(read("next_retry_at"))) return null;

  return {
    outcome: outcome as CompetitorOutcome,
    source: null,
    reasonCode: reasonCode as CompetitorReasonCode,
    written: 0,
    mediaCount: 0,
    capturedAt: null,
    coverage: null,
  };
}

// ---------------------------------------------------------------------------
// The throttle receipt
// ---------------------------------------------------------------------------

/**
 * Parses the throttle receipt.
 *
 * A null or partial receipt is not proof the shared backoff was stored. A
 * job-scoped throttle must answer for that job and report it parked.
 */
export function isThrottleReceipt(
  value: unknown,
  request: { readonly bucketKey: string; readonly jobId: string | null },
): boolean {
  if (!isPlainRecord(value)) return false;
  const read = (key: string) => readOwnData(value, key).value;
  if (read("bucket_key") !== request.bucketKey) return false;
  const usage = read("usage_percent");
  if (usage !== null && !isNonNegativeSafeInteger(usage)) return false;
  if (!isNullableTimestamp(read("throttled_until"))) return false;

  if (request.jobId === null) {
    return hasExactKeys(value, THROTTLE_GLOBAL_KEYS) && read("job_id") === null;
  }
  const jobId = read("job_id");
  return hasExactKeys(value, THROTTLE_PARKED_KEYS) &&
    isUuidText(jobId) && sameUuid(jobId, request.jobId) && read("status") === "retry";
}
