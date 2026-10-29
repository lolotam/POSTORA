/**
 * The owner-facing wire contract for the Instagram insights collector.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The two owner RPCs of the accepted migration
 *   `20261026150000_instagram_durable_collection_jobs.sql`:
 *
 *     enqueue_instagram_collection_job(p_target_kind, p_target_id, p_mode)
 *     read_instagram_collection_job_status(p_target_kind, p_target_id, p_capture_day)
 *
 *   Both are granted to `authenticated` and explicitly revoked from
 *   `service_role`. They derive the owner from `auth.uid()` and check the
 *   target structurally, so this module never sends an owner id: it sends the
 *   target and lets the database decide who owns it.
 *
 * WHY THE RECEIPTS ARE PARSED, NOT CAST
 *
 *   The accepted SQL returns closed projections. A receipt that has an extra
 *   key, a missing key, a null where the SQL never returns null, or a value
 *   outside the SQL's own domain is NOT a receipt: it is a deployment that no
 *   longer matches this contract. It is refused here, before it can reach a
 *   client or a log.
 *
 *   Every required property is read through its OWN DATA DESCRIPTOR. A
 *   descriptor that is an accessor is refused WITHOUT being invoked, so a
 *   driver result that carries a getter can never run code inside this
 *   process, and an inherited property can never become authority.
 *
 * WHY THE TIMESTAMPS ARE NOT PARSED BY `Date`
 *
 *   `new Date("2026-02-30")` is a March date, and JavaScript silently
 *   normalises a day that the database would never store. Every date and
 *   timestamp here is validated arithmetically, against the proleptic
 *   Gregorian calendar the database uses, so an impossible day is refused
 *   rather than moved.
 *
 * WHAT THIS MODULE NEVER DOES
 *
 *   It never reads a lease token, a cursor, a credential or provider text,
 *   because the accepted projections do not carry them and an unknown key is
 *   refused instead of forwarded. It never writes a setting, and it never
 *   calls a provider.
 */

/** The target kind this endpoint is allowed to use. It is fixed, not chosen by a caller. */
export const OWNER_TARGET_KIND = "owner" as const;

/** The seven job statuses the accepted SQL's CHECK constraint allows. */
export const OWNER_JOB_STATUSES = [
  "queued",
  "leased",
  "retry",
  "partial",
  "completed",
  "unavailable",
  "error",
] as const;

export type OwnerJobStatus = (typeof OWNER_JOB_STATUSES)[number];

/** The no-job status. Only the no-job variant may use it. */
export const OWNER_NO_JOB_STATUS = "none" as const;

/**
 * The exact key sets of the accepted projections. A receipt with a different
 * key set belongs to a different contract and is refused.
 */
const ENQUEUE_ACCEPTED_KEYS = [
  "accepted",
  "reason",
  "job_id",
  "job_generation",
  "status",
  "captured_on",
  "created",
  "accepted_at",
] as const;

const ENQUEUE_THROTTLED_KEYS = [
  "accepted",
  "reason",
  "retry_after_seconds",
  "captured_on",
] as const;

/** The thirteen keys both status variants share. */
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
] as const;

/** The fourteen keys of the actual-job variant. */
const STATUS_JOB_KEYS = [...STATUS_SHARED_KEYS, "pending_operations"] as const;

const INVENTORY_KEYS = [
  "truncated",
  "partial",
  "window_covered",
  "oldest_returned_at",
  "gap_reason",
  "pages_fetched",
] as const;

/**
 * The accepted throttle window is fifteen minutes. The SQL derives the retry
 * hint from that window, so a larger value is not a receipt this contract
 * knows how to honour.
 */
const MAX_RETRY_AFTER_SECONDS = 900;

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const TIMESTAMP_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/;

/** A sanitised reason code. Lower-case snake_case, bounded length, never raw text. */
const REASON_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** True for a clean, hyphenated UUID string in either hexadecimal case. */
export function isUuidText(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

/**
 * The canonical lower-case form PostgreSQL prints for a uuid. The comparison
 * is case-insensitive at the boundary, but only one case is ever stored.
 */
export function canonicalUuid(value: string): string {
  return value.toLowerCase();
}

/**
 * A real Gregorian calendar date in years 0001 to 9999.
 *
 * The arithmetic is deliberately not delegated to `Date`: JavaScript
 * normalises 30 February into March, and a normalised invalid day must be
 * refused, not repaired.
 */
export function isGregorianCalendarDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  if (year < 1 || year > 9999) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1) return false;

  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [
    31,
    leap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];

  return day <= daysInMonth[month - 1]!;
}

/**
 * A finite zoned timestamp. `infinity` is a valid PostgreSQL literal and is
 * not evidence of anything, so it is refused together with a missing zone.
 */
export function isFiniteZonedTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = TIMESTAMP_PATTERN.exec(value);
  if (!match) return false;

  if (!isGregorianCalendarDate(`${match[1]}-${match[2]}-${match[3]}`)) return false;

  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  if (hour > 23 || minute > 59 || second > 60) return false;

  const zone = match[7]!;
  if (zone !== "Z") {
    const zoneHour = Number(zone.slice(1, 3));
    const zoneMinute = Number(zone.slice(4, 6));
    if (zoneHour > 23 || zoneMinute > 59) return false;
  }

  return true;
}

function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isJobStatus(value: unknown): value is OwnerJobStatus {
  return typeof value === "string" && (OWNER_JOB_STATUSES as readonly string[]).includes(value);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Reads an OWN DATA property without invoking an accessor.
 *
 * An inherited value is not authority, and an accessor is not a value this
 * contract accepts: both are reported as absent so the caller refuses the
 * receipt instead of running code it did not expect.
 */
function readOwnData(
  record: object,
  key: string,
): { readonly present: boolean; readonly value: unknown } {
  if (!Object.hasOwn(record, key)) return { present: false, value: undefined };
  const descriptor = Object.getOwnPropertyDescriptor(record, key);
  if (!descriptor || !("value" in descriptor)) return { present: false, value: undefined };
  return { present: true, value: descriptor.value };
}

/**
 * True when the record carries exactly the expected own keys and nothing
 * else. An unknown key is refused rather than dropped: a receipt that grew a
 * lease token or a provider message belongs to another contract.
 */
function hasExactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(record, key));
}

/** The driver envelope. Only the SQLSTATE is retained; the message is never read. */
export interface OwnerRpcEnvelope {
  readonly data: unknown;
  readonly error: { readonly code?: string | null } | null;
}

/**
 * The narrow user-context RPC caller.
 *
 * The result is `unknown` because the driver envelope is untrusted. A missing
 * field, an inherited field or an accessor is not a receipt, and this port
 * must not retype that object into `OwnerRpcEnvelope` before the descriptor
 * check below. The caller runs the request as the VERIFIED CALLER, so
 * `auth.uid()` inside PostgreSQL is the caller's own id. The service client
 * is not an acceptable implementation of this port: the accepted SQL has no
 * `service_role` EXECUTE on these two functions.
 */
export type UserRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<unknown>;

export interface OwnerEnqueueAcceptedProjection {
  readonly accepted: true;
  readonly reason: "enqueued" | "already_enqueued" | "forced";
  readonly job_id: string;
  readonly job_generation: number;
  readonly status: OwnerJobStatus;
  readonly captured_on: string;
  readonly created: boolean;
  readonly accepted_at: string;
}

export interface OwnerEnqueueThrottledProjection {
  readonly accepted: false;
  readonly reason: "throttled";
  readonly retry_after_seconds: number;
  readonly captured_on: string;
}

export type OwnerEnqueueOutcome =
  | { readonly kind: "accepted"; readonly projection: OwnerEnqueueAcceptedProjection }
  | { readonly kind: "throttled"; readonly projection: OwnerEnqueueThrottledProjection };

export interface OwnerInventoryProjection {
  readonly truncated: boolean;
  readonly partial: boolean;
  readonly window_covered: boolean;
  readonly oldest_returned_at: string | null;
  readonly gap_reason: string | null;
  readonly pages_fetched: number;
}

/**
 * The status projection. The no-job variant has no `pending_operations`
 * key at all; the actual-job variant always has it, as a scalar count.
 */
export interface OwnerStatusProjection {
  readonly target_kind: typeof OWNER_TARGET_KIND;
  readonly target_id: string;
  readonly captured_on: string;
  readonly status: OwnerJobStatus | typeof OWNER_NO_JOB_STATUS;
  readonly job_generation: number;
  readonly attempts: number;
  readonly due_at: string | null;
  readonly next_retry_at: string | null;
  readonly last_attempt_at: string | null;
  readonly last_partial_at: string | null;
  readonly last_success_at: string | null;
  readonly reason_code: string | null;
  readonly inventory: OwnerInventoryProjection;
  readonly pending_operations?: number;
}

export interface OwnerEnqueueInput {
  readonly socialAccountId: string;
  readonly mode: "normal" | "force";
  readonly signal: AbortSignal;
}

export interface OwnerStatusInput {
  readonly socialAccountId: string;
  /** The requested capture day, or null when the caller omitted it. */
  readonly capturedOn: string | null;
  readonly signal: AbortSignal;
}

export interface OwnerCollectionStore {
  enqueueOwnerJob(input: OwnerEnqueueInput): Promise<OwnerEnqueueOutcome>;
  readOwnerStatus(input: OwnerStatusInput): Promise<OwnerStatusProjection>;
}

/**
 * How a store call failed.
 *
 *   target_not_found  - the database refused the target (missing, inactive or
 *                       owned by somebody else). The caller maps it to the one
 *                       404, because the caller must not learn whether the
 *                       target exists.
 *   request_refused   - a definitive SQL refusal of the request shape.
 *   unauthorized      - the database refused the caller's role.
 *   indeterminate     - the outcome is unknown: a transport failure, a
 *                       timeout, a lost receipt or a receipt that does not
 *                       match this contract. The write may have committed.
 */
export type OwnerStoreFailure =
  | "target_not_found"
  | "request_refused"
  | "unauthorized"
  | "indeterminate";

export class OwnerCollectionStoreError extends Error {
  readonly failure: OwnerStoreFailure;

  constructor(failure: OwnerStoreFailure) {
    // The message is deliberately generic. A SQL error text can quote a
    // target, an owner or a statement, and it never reaches a client.
    super("The Instagram collection request could not be completed.");
    this.name = "OwnerCollectionStoreError";
    this.failure = failure;
  }
}

function readErrorCode(error: unknown): string | null {
  if (!isPlainRecord(error)) return null;
  const code = readOwnData(error, "code");
  if (!code.present || typeof code.value !== "string") return null;
  return code.value;
}

/**
 * Maps a SQLSTATE onto the small failure vocabulary above.
 *
 * P0002 is the target refusal, 22023 is a request refusal, 42501 is a role
 * refusal. Everything else - including a missing function, a transport
 * failure and a timeout - is indeterminate: the statement may have run.
 */
function classifyErrorCode(code: string | null): OwnerStoreFailure {
  if (code === "P0002") return "target_not_found";
  if (code === "22023") return "request_refused";
  if (code === "42501") return "unauthorized";
  return "indeterminate";
}

interface RpcOutcome {
  readonly ok: boolean;
  readonly data?: unknown;
  readonly failure?: OwnerStoreFailure;
}

async function invokeOwnerRpc(
  caller: UserRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
): Promise<RpcOutcome> {
  let envelope: unknown;
  try {
    envelope = await caller(functionName, args, signal);
  } catch {
    // A thrown transport error is a failed write or a failed read. It is
    // never an empty success, and it never becomes a rollback claim.
    return { ok: false, failure: "indeterminate" };
  }

  if (!isPlainRecord(envelope)) return { ok: false, failure: "indeterminate" };

  const error = readOwnData(envelope, "error");
  if (!error.present) return { ok: false, failure: "indeterminate" };

  // A SQLSTATE is definitive only when `data` is an own data field too.
  // A missing or accessor `data` leaves the driver envelope incomplete, so
  // the code is not read and cannot become a not-found or another refusal.
  const data = readOwnData(envelope, "data");
  if (!data.present) return { ok: false, failure: "indeterminate" };

  if (error.value !== null) {
    return { ok: false, failure: classifyErrorCode(readErrorCode(error.value)) };
  }

  return { ok: true, data: data.value };
}

function parseInventory(value: unknown): OwnerInventoryProjection | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, INVENTORY_KEYS)) return null;

  const truncated = readOwnData(value, "truncated");
  if (!truncated.present || typeof truncated.value !== "boolean") return null;

  const partial = readOwnData(value, "partial");
  if (!partial.present || typeof partial.value !== "boolean") return null;

  const windowCovered = readOwnData(value, "window_covered");
  if (!windowCovered.present || typeof windowCovered.value !== "boolean") return null;

  const oldestReturnedAt = readOwnData(value, "oldest_returned_at");
  if (!oldestReturnedAt.present) return null;
  if (oldestReturnedAt.value !== null && !isFiniteZonedTimestamp(oldestReturnedAt.value)) {
    return null;
  }

  const gapReason = readOwnData(value, "gap_reason");
  if (!gapReason.present) return null;
  if (gapReason.value !== null && !isReasonCode(gapReason.value)) return null;

  const pagesFetched = readOwnData(value, "pages_fetched");
  if (!pagesFetched.present || !isNonNegativeSafeInteger(pagesFetched.value)) return null;

  return {
    truncated: truncated.value,
    partial: partial.value,
    window_covered: windowCovered.value,
    oldest_returned_at: oldestReturnedAt.value === null ? null : oldestReturnedAt.value,
    gap_reason: gapReason.value === null ? null : gapReason.value,
    pages_fetched: pagesFetched.value,
  };
}

function parseEnqueueAccepted(
  value: unknown,
  mode: "normal" | "force",
): OwnerEnqueueAcceptedProjection | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, ENQUEUE_ACCEPTED_KEYS)) return null;

  const accepted = readOwnData(value, "accepted");
  if (!accepted.present || accepted.value !== true) return null;

  const reason = readOwnData(value, "reason");
  if (!reason.present) return null;
  if (
    reason.value !== "enqueued" &&
    reason.value !== "already_enqueued" &&
    reason.value !== "forced"
  ) {
    return null;
  }

  const created = readOwnData(value, "created");
  if (!created.present || typeof created.value !== "boolean") return null;

  // The requested mode and the accepted reason must agree. A normal request
  // is never answered with a force, and a force is never answered with an
  // ordinary enqueue.
  if (mode === "force" && reason.value !== "forced") return null;
  if (mode === "normal" && reason.value === "forced") return null;

  // The SQL derives the reason from whether the row existed. The two must
  // not contradict each other.
  if (reason.value === "enqueued" && created.value !== true) return null;
  if (reason.value === "already_enqueued" && created.value !== false) return null;

  const jobId = readOwnData(value, "job_id");
  if (!jobId.present || !isUuidText(jobId.value)) return null;

  const jobGeneration = readOwnData(value, "job_generation");
  if (!jobGeneration.present || !isPositiveSafeInteger(jobGeneration.value)) return null;

  const status = readOwnData(value, "status");
  if (!status.present || !isJobStatus(status.value)) return null;

  // Newly enqueued work and forced work are both queued. An existing normal
  // job may truthfully be completed, and that is not a new sync.
  if ((reason.value === "enqueued" || reason.value === "forced") && status.value !== "queued") {
    return null;
  }

  const capturedOn = readOwnData(value, "captured_on");
  if (!capturedOn.present || !isGregorianCalendarDate(capturedOn.value)) return null;

  const acceptedAt = readOwnData(value, "accepted_at");
  if (!acceptedAt.present || !isFiniteZonedTimestamp(acceptedAt.value)) return null;

  return {
    accepted: true,
    reason: reason.value,
    job_id: canonicalUuid(jobId.value),
    job_generation: jobGeneration.value,
    status: status.value,
    captured_on: capturedOn.value,
    created: created.value,
    accepted_at: acceptedAt.value,
  };
}

function parseEnqueueThrottled(value: unknown): OwnerEnqueueThrottledProjection | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, ENQUEUE_THROTTLED_KEYS)) return null;

  const accepted = readOwnData(value, "accepted");
  if (!accepted.present || accepted.value !== false) return null;

  const reason = readOwnData(value, "reason");
  if (!reason.present || reason.value !== "throttled") return null;

  const retryAfterSeconds = readOwnData(value, "retry_after_seconds");
  if (!retryAfterSeconds.present || !isNonNegativeSafeInteger(retryAfterSeconds.value)) {
    return null;
  }
  if (retryAfterSeconds.value > MAX_RETRY_AFTER_SECONDS) return null;

  const capturedOn = readOwnData(value, "captured_on");
  if (!capturedOn.present || !isGregorianCalendarDate(capturedOn.value)) return null;

  return {
    accepted: false,
    reason: "throttled",
    retry_after_seconds: retryAfterSeconds.value,
    captured_on: capturedOn.value,
  };
}

/**
 * Parses the status projection and checks it against what the caller asked
 * for.
 *
 * The target kind and the target account must agree with the request, and an
 * explicitly requested capture day must be the day the database answered
 * for. When the caller omitted the day, the database's own Kuwait day is
 * accepted as it is: this module never computes "today" itself, because a
 * UTC calculation would disagree with the database at the Kuwait boundary.
 */
function parseOwnerStatus(
  value: unknown,
  requestedAccountId: string,
  requestedCapturedOn: string | null,
): OwnerStatusProjection | null {
  if (!isPlainRecord(value)) return null;

  const statusValue = readOwnData(value, "status");
  if (!statusValue.present) return null;
  const isNoJob = statusValue.value === OWNER_NO_JOB_STATUS;
  if (!isNoJob && !isJobStatus(statusValue.value)) return null;

  if (!hasExactKeys(value, isNoJob ? STATUS_SHARED_KEYS : STATUS_JOB_KEYS)) return null;

  const targetKind = readOwnData(value, "target_kind");
  if (!targetKind.present || targetKind.value !== OWNER_TARGET_KIND) return null;

  const targetId = readOwnData(value, "target_id");
  if (!targetId.present || !isUuidText(targetId.value)) return null;
  if (canonicalUuid(targetId.value) !== canonicalUuid(requestedAccountId)) return null;

  const capturedOn = readOwnData(value, "captured_on");
  if (!capturedOn.present || !isGregorianCalendarDate(capturedOn.value)) return null;
  if (requestedCapturedOn !== null && capturedOn.value !== requestedCapturedOn) return null;

  const jobGeneration = readOwnData(value, "job_generation");
  if (!jobGeneration.present || !isNonNegativeSafeInteger(jobGeneration.value)) return null;

  const attempts = readOwnData(value, "attempts");
  if (!attempts.present || !isNonNegativeSafeInteger(attempts.value)) return null;

  const dueAt = readOwnData(value, "due_at");
  if (!dueAt.present) return null;

  const nextRetryAt = readOwnData(value, "next_retry_at");
  if (!nextRetryAt.present) return null;

  const lastAttemptAt = readOwnData(value, "last_attempt_at");
  if (!lastAttemptAt.present) return null;

  const lastPartialAt = readOwnData(value, "last_partial_at");
  if (!lastPartialAt.present) return null;

  const lastSuccessAt = readOwnData(value, "last_success_at");
  if (!lastSuccessAt.present) return null;

  const reasonCode = readOwnData(value, "reason_code");
  if (!reasonCode.present) return null;
  if (reasonCode.value !== null && !isReasonCode(reasonCode.value)) return null;

  const inventory = parseInventory(readOwnData(value, "inventory").value);
  if (!inventory) return null;

  if (isNoJob) {
    // Only the no-job variant may use the zero generation, the zero attempt
    // count, the null times and the empty inventory.
    if (jobGeneration.value !== 0) return null;
    if (attempts.value !== 0) return null;
    if (dueAt.value !== null) return null;
    if (nextRetryAt.value !== null) return null;
    if (lastAttemptAt.value !== null) return null;
    if (lastPartialAt.value !== null) return null;
    if (lastSuccessAt.value !== null) return null;
    if (reasonCode.value !== null) return null;
    if (inventory.truncated !== false) return null;
    if (inventory.partial !== false) return null;
    if (inventory.window_covered !== false) return null;
    if (inventory.oldest_returned_at !== null) return null;
    if (inventory.gap_reason !== null) return null;
    if (inventory.pages_fetched !== 0) return null;

    return {
      target_kind: OWNER_TARGET_KIND,
      target_id: canonicalUuid(targetId.value),
      captured_on: capturedOn.value,
      status: OWNER_NO_JOB_STATUS,
      job_generation: 0,
      attempts: 0,
      due_at: null,
      next_retry_at: null,
      last_attempt_at: null,
      last_partial_at: null,
      last_success_at: null,
      reason_code: null,
      inventory,
    };
  }

  // An actual job always has a positive generation and a due time.
  if (!isPositiveSafeInteger(jobGeneration.value)) return null;
  if (!isFiniteZonedTimestamp(dueAt.value)) return null;
  if (nextRetryAt.value !== null && !isFiniteZonedTimestamp(nextRetryAt.value)) return null;
  if (lastAttemptAt.value !== null && !isFiniteZonedTimestamp(lastAttemptAt.value)) return null;
  if (lastPartialAt.value !== null && !isFiniteZonedTimestamp(lastPartialAt.value)) return null;
  if (lastSuccessAt.value !== null && !isFiniteZonedTimestamp(lastSuccessAt.value)) return null;

  const pendingOperations = readOwnData(value, "pending_operations");
  if (!pendingOperations.present || !isNonNegativeSafeInteger(pendingOperations.value)) {
    return null;
  }

  return {
    target_kind: OWNER_TARGET_KIND,
    target_id: canonicalUuid(targetId.value),
    captured_on: capturedOn.value,
    status: statusValue.value,
    job_generation: jobGeneration.value,
    attempts: attempts.value,
    due_at: dueAt.value,
    next_retry_at: nextRetryAt.value === null ? null : nextRetryAt.value,
    last_attempt_at: lastAttemptAt.value === null ? null : lastAttemptAt.value,
    last_partial_at: lastPartialAt.value === null ? null : lastPartialAt.value,
    last_success_at: lastSuccessAt.value === null ? null : lastSuccessAt.value,
    reason_code: reasonCode.value === null ? null : reasonCode.value,
    inventory,
    pending_operations: pendingOperations.value,
  };
}

/**
 * The authenticated owner store.
 *
 * The caller it receives is a USER-context caller: the request runs as the
 * verified caller, so the database derives the owner from `auth.uid()` and
 * the accepted structural ownership check is the authority. A service client
 * cannot be used here; the accepted SQL refuses it.
 */
export function createOwnerCollectionStore(caller: UserRpcCaller): OwnerCollectionStore {
  return {
    async enqueueOwnerJob(input: OwnerEnqueueInput): Promise<OwnerEnqueueOutcome> {
      const outcome = await invokeOwnerRpc(
        caller,
        "enqueue_instagram_collection_job",
        {
          p_target_kind: OWNER_TARGET_KIND,
          p_target_id: input.socialAccountId,
          p_mode: input.mode,
        },
        input.signal,
      );

      if (!outcome.ok) {
        throw new OwnerCollectionStoreError(outcome.failure ?? "indeterminate");
      }

      const accepted = parseEnqueueAccepted(outcome.data, input.mode);
      if (accepted) return { kind: "accepted", projection: accepted };

      const throttled = parseEnqueueThrottled(outcome.data);
      if (throttled) return { kind: "throttled", projection: throttled };

      // A receipt that matches neither accepted projection is not a receipt
      // this contract knows. The statement may have committed, so the caller
      // is told the outcome is indeterminate and is never told it succeeded.
      throw new OwnerCollectionStoreError("indeterminate");
    },

    async readOwnerStatus(input: OwnerStatusInput): Promise<OwnerStatusProjection> {
      const outcome = await invokeOwnerRpc(
        caller,
        "read_instagram_collection_job_status",
        {
          p_target_kind: OWNER_TARGET_KIND,
          p_target_id: input.socialAccountId,
          p_capture_day: input.capturedOn,
        },
        input.signal,
      );

      if (!outcome.ok) {
        throw new OwnerCollectionStoreError(outcome.failure ?? "indeterminate");
      }

      const projection = parseOwnerStatus(outcome.data, input.socialAccountId, input.capturedOn);
      if (!projection) {
        // A failed or malformed read is unavailable. It is never reported as
        // an empty history.
        throw new OwnerCollectionStoreError("indeterminate");
      }

      return projection;
    },
  };
}
