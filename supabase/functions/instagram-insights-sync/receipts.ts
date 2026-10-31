/**
 * Strict parsers for the durable Instagram collection receipts.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The exact shapes of the accepted SQL projections of
 *   `20261026150000_instagram_durable_collection_jobs.sql`, and the rule that
 *   a receipt must agree with the request that produced it. A parser returns
 *   `null` for anything that is not exactly the documented projection; the
 *   store turns that into an indeterminate failure. Nothing here invents a
 *   default: a malformed claim is never "no jobs", a malformed write receipt
 *   is never "written".
 *
 * WHY OWN DATA DESCRIPTORS
 *
 *   An inherited value is not authority and an accessor is code this contract
 *   did not ask to run. Both read as absent, and a required value that reads
 *   as absent is a refusal.
 *
 * WHY THE CLAIM ROW IS PARSED EXACTLY BUT THE CHECKPOINT IS NOT
 *
 *   The claim row is a closed projection built by `jsonb_build_object`: its
 *   key set is part of the contract, so an extra key means a different
 *   deployment and is refused. The checkpoint is the job's own mutable state
 *   bag: the accepted table may gain a column, and a new column is not a
 *   reason to refuse a claim. Every checkpoint field this worker ACTS on is
 *   still read through its own data descriptor and type-checked, so a
 *   malformed value is refused rather than believed.
 *
 * WHY NO PROVIDER OR DRIVER TEXT IS EVER COPIED
 *
 *   A reason code is lower-case snake_case and a receipt carries only
 *   database values. A Graph message can quote the token, the account id or
 *   an internal URL, so it never becomes a reason code, a stored
 *   `last_reason_code`, a log line or a client response.
 */

/** The one UUID shape PostgreSQL prints. */
const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** A calendar date. */
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A zoned timestamp. PostgreSQL always prints the offset. */
const TIMESTAMP_PATTERN =
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}(?::?\d{2})?)$/;

/** The reason-code grammar the accepted SQL enforces. */
const REASON_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

/** The throttle bucket key grammar the accepted SQL enforces. */
const BUCKET_KEY_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The exact key sets of the accepted projections.
 *
 * A receipt with a different key set belongs to a different contract and is
 * refused instead of being read loosely.
 */
const CLAIM_KEYS = [
  "job_id",
  "user_id",
  "target_kind",
  "target_id",
  "social_account_id",
  "watchlist_id",
  "captured_on",
  "job_generation",
  "claim_token",
  "lease_expires_at",
  "attempts",
  "context",
  "checkpoint",
  "pending_operations",
  "claimed_at",
] as const;

const CONTEXT_KEYS = [
  "viewer_social_account_id",
  "credential_generation",
  "login_kind",
  "capability_present",
  "permission_read_state",
  "granted_scopes",
] as const;

const SNAPSHOT_KEYS = ["job_id", "job_generation", "written"] as const;
const PROGRESS_OPERATIONS_KEYS = ["job_id", "job_generation", "recorded"] as const;
const PROGRESS_INVENTORY_KEYS = ["job_id", "job_generation", "inventory"] as const;
const COMPLETE_KEYS = [
  "job_id",
  "job_generation",
  "status",
  "outcome",
  "reason_code",
] as const;
const THROTTLE_BUCKET_KEYS = [
  "bucket_key",
  "usage_percent",
  "throttled_until",
  "job_id",
] as const;
const THROTTLE_PARKED_KEYS = [...THROTTLE_BUCKET_KEYS, "status"] as const;

/**
 * The exact key set of the direct credential reader's answer.
 *
 * The reader is a closed projection built by `jsonb_build_object`, so an
 * extra key means a different deployment and is refused. A refresh token or
 * an account metadata key in this document is a contract violation, not a
 * field to ignore.
 */
const DIRECT_CREDENTIAL_KEYS = [
  "job_id",
  "user_id",
  "social_account_id",
  "ig_user_id",
  "login_kind",
  "credential_generation",
  "access_token",
  "token_expires_at",
] as const;

/** The outcomes `complete_instagram_collection_job` accepts. */
export const OWNER_JOB_OUTCOMES = [
  "completed",
  "partial",
  "retry",
  "unavailable",
  "error",
] as const;

export type OwnerJobOutcome = (typeof OWNER_JOB_OUTCOMES)[number];

/** The job statuses the accepted SQL's CHECK constraint allows. */
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

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
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
export function readOwnData(
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
 * else. An unknown key is refused rather than dropped.
 */
export function hasExactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(record, key));
}

export function isUuidText(value: unknown): value is string {
  return typeof value === "string" && UUID_PATTERN.test(value);
}

export function isDateText(value: unknown): value is string {
  if (typeof value !== "string" || !DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

export function isTimestampText(value: unknown): value is string {
  if (typeof value !== "string" || !TIMESTAMP_PATTERN.test(value)) return false;
  return !Number.isNaN(new Date(value).getTime());
}

export function isNullableTimestamp(value: unknown): value is string | null {
  return value === null || isTimestampText(value);
}

export function isReasonCode(value: unknown): value is string {
  return typeof value === "string" && REASON_CODE_PATTERN.test(value);
}

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

export function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

export function isJobStatus(value: unknown): value is OwnerJobStatus {
  return typeof value === "string" && (OWNER_JOB_STATUSES as readonly string[]).includes(value);
}

export function isJobOutcome(value: unknown): value is OwnerJobOutcome {
  return typeof value === "string" && (OWNER_JOB_OUTCOMES as readonly string[]).includes(value);
}

function sameUuid(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

/** The connection context the claim captured for this generation. */
export interface ClaimedOwnerContext {
  readonly viewerSocialAccountId: string | null;
  readonly credentialGeneration: number | null;
  readonly loginKind: "direct" | "page_linked" | null;
  readonly capabilityPresent: boolean;
  readonly permissionReadState: string | null;
  readonly grantedScopes: readonly string[];
}

/** The media inventory checkpoint of the current generation. */
export interface ClaimedInventoryCheckpoint {
  readonly cursor: string | null;
  readonly remainingIds: readonly string[];
  readonly pagesFetched: number;
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly oldestReturnedAt: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly windowCovered: boolean;
  readonly gapReason: string | null;
}

/** One claimed owner job. */
export interface ClaimedOwnerJob {
  readonly jobId: string;
  readonly userId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly socialAccountId: string;
  readonly watchlistId: string | null;
  readonly capturedOn: string;
  readonly jobGeneration: number;
  readonly claimToken: string;
  readonly leaseExpiresAt: string;
  readonly attempts: number;
  readonly context: ClaimedOwnerContext;
  readonly checkpoint: ClaimedInventoryCheckpoint;
  readonly pendingOperations: readonly string[];
  readonly claimedAt: string;
}

const EMPTY_CHECKPOINT: ClaimedInventoryCheckpoint = {
  cursor: null,
  remainingIds: [],
  pagesFetched: 0,
  partial: false,
  truncated: false,
  oldestReturnedAt: null,
  windowStart: null,
  windowEnd: null,
  windowCovered: false,
  gapReason: null,
};

function parseContext(value: unknown): ClaimedOwnerContext | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, CONTEXT_KEYS)) return null;

  const viewer = readOwnData(value, "viewer_social_account_id").value;
  if (viewer !== null && !isUuidText(viewer)) return null;

  const generation = readOwnData(value, "credential_generation").value;
  if (generation !== null && !isPositiveSafeInteger(generation)) return null;

  const loginKind = readOwnData(value, "login_kind").value;
  if (loginKind !== null && loginKind !== "direct" && loginKind !== "page_linked") return null;

  const capabilityPresent = readOwnData(value, "capability_present").value;
  if (typeof capabilityPresent !== "boolean") return null;

  const permissionReadState = readOwnData(value, "permission_read_state").value;
  if (permissionReadState !== null && typeof permissionReadState !== "string") return null;

  const scopes = readOwnData(value, "granted_scopes").value;
  if (!Array.isArray(scopes)) return null;
  for (const scope of scopes) {
    if (typeof scope !== "string") return null;
  }

  return {
    viewerSocialAccountId: viewer === null ? null : (viewer as string),
    credentialGeneration: generation as number | null,
    loginKind: loginKind as "direct" | "page_linked" | null,
    capabilityPresent,
    permissionReadState: permissionReadState as string | null,
    grantedScopes: scopes as string[],
  };
}

/**
 * Parses the inventory checkpoint.
 *
 * The checkpoint is the job's own state, so an unknown column is ignored. A
 * field this worker acts on is still type-checked: a malformed value is a
 * refusal, not a belief.
 */
function parseCheckpoint(value: unknown): ClaimedInventoryCheckpoint | null {
  if (!isPlainRecord(value)) return null;

  const cursor = readOwnData(value, "inventory_cursor").value;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return null;

  const remaining = readOwnData(value, "inventory_remaining_ids").value;
  if (remaining !== undefined && remaining !== null) {
    if (!Array.isArray(remaining)) return null;
    for (const id of remaining) {
      if (typeof id !== "string") return null;
    }
  }

  const pagesFetched = readOwnData(value, "inventory_pages_fetched").value;
  if (pagesFetched !== undefined && !isNonNegativeSafeInteger(pagesFetched)) return null;

  const partial = readOwnData(value, "inventory_partial").value;
  if (partial !== undefined && typeof partial !== "boolean") return null;

  const truncated = readOwnData(value, "inventory_truncated").value;
  if (truncated !== undefined && typeof truncated !== "boolean") return null;

  const oldest = readOwnData(value, "inventory_oldest_returned_at").value;
  if (oldest !== undefined && oldest !== null && !isTimestampText(oldest)) return null;

  const windowStart = readOwnData(value, "inventory_window_start").value;
  if (windowStart !== undefined && windowStart !== null && !isDateText(windowStart)) return null;

  const windowEnd = readOwnData(value, "inventory_window_end").value;
  if (windowEnd !== undefined && windowEnd !== null && !isDateText(windowEnd)) return null;

  const covered = readOwnData(value, "inventory_window_covered").value;
  if (covered !== undefined && typeof covered !== "boolean") return null;

  const gapReason = readOwnData(value, "inventory_gap_reason").value;
  if (gapReason !== undefined && gapReason !== null && !isReasonCode(gapReason)) return null;

  return {
    cursor: typeof cursor === "string" ? cursor : null,
    remainingIds: Array.isArray(remaining) ? (remaining as string[]) : [],
    pagesFetched: isNonNegativeSafeInteger(pagesFetched) ? pagesFetched : 0,
    partial: partial === true,
    truncated: truncated === true,
    oldestReturnedAt: typeof oldest === "string" ? oldest : null,
    windowStart: typeof windowStart === "string" ? windowStart : null,
    windowEnd: typeof windowEnd === "string" ? windowEnd : null,
    windowCovered: covered === true,
    gapReason: typeof gapReason === "string" ? gapReason : null,
  };
}

/**
 * Parses one claimed job.
 *
 * The row must be an owner job: a competitor job has no owner account to
 * collect for, and a worker that claimed one has to refuse it rather than
 * collect the wrong thing.
 */
export function parseClaimedOwnerJob(value: unknown): ClaimedOwnerJob | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, CLAIM_KEYS)) return null;

  const jobId = readOwnData(value, "job_id").value;
  const userId = readOwnData(value, "user_id").value;
  const targetKind = readOwnData(value, "target_kind").value;
  const targetId = readOwnData(value, "target_id").value;
  const socialAccountId = readOwnData(value, "social_account_id").value;
  const watchlistId = readOwnData(value, "watchlist_id").value;
  const capturedOn = readOwnData(value, "captured_on").value;
  const jobGeneration = readOwnData(value, "job_generation").value;
  const claimToken = readOwnData(value, "claim_token").value;
  const leaseExpiresAt = readOwnData(value, "lease_expires_at").value;
  const attempts = readOwnData(value, "attempts").value;
  const claimedAt = readOwnData(value, "claimed_at").value;

  if (!isUuidText(jobId) || !isUuidText(userId) || !isUuidText(targetId)) return null;
  if (targetKind !== "owner") return null;
  if (!isUuidText(socialAccountId)) return null;
  if (watchlistId !== null && !isUuidText(watchlistId)) return null;
  if (!isDateText(capturedOn)) return null;
  if (!isPositiveSafeInteger(jobGeneration)) return null;
  if (!isUuidText(claimToken)) return null;
  if (!isTimestampText(leaseExpiresAt)) return null;
  if (!isNonNegativeSafeInteger(attempts)) return null;
  if (!isTimestampText(claimedAt)) return null;

  const context = parseContext(readOwnData(value, "context").value);
  if (context === null) return null;

  const checkpoint = parseCheckpoint(readOwnData(value, "checkpoint").value);
  if (checkpoint === null) return null;

  const operations = readOwnData(value, "pending_operations").value;
  if (!Array.isArray(operations)) return null;
  const operationKeys: string[] = [];
  for (const entry of operations) {
    if (!isPlainRecord(entry)) return null;
    const key = readOwnData(entry, "operation_key").value;
    if (typeof key !== "string") return null;
    operationKeys.push(key);
  }

  return {
    jobId: jobId.toLowerCase(),
    userId: userId.toLowerCase(),
    targetKind,
    targetId: targetId.toLowerCase(),
    socialAccountId: socialAccountId.toLowerCase(),
    watchlistId: watchlistId === null ? null : (watchlistId as string).toLowerCase(),
    capturedOn,
    jobGeneration,
    claimToken: claimToken.toLowerCase(),
    leaseExpiresAt,
    attempts,
    context,
    checkpoint,
    pendingOperations: operationKeys,
    claimedAt,
  };
}

// ---------------------------------------------------------------------------
// The write receipts
// ---------------------------------------------------------------------------

/** The receipt of one snapshot write. */
export interface SnapshotReceipt {
  readonly jobId: string;
  readonly jobGeneration: number;
  readonly written: number;
}

/**
 * Parses the snapshot receipt and binds it to the request.
 *
 * The receipt must name the same job and generation, and the number of
 * written items must be the number of items the payload carried. A receipt
 * that disagrees is not evidence that the write happened as asked.
 */
export function parseSnapshotReceipt(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly itemCount: number;
  },
): SnapshotReceipt | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, SNAPSHOT_KEYS)) return null;

  const jobId = readOwnData(value, "job_id").value;
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;

  const jobGeneration = readOwnData(value, "job_generation").value;
  if (jobGeneration !== request.jobGeneration) return null;

  const written = readOwnData(value, "written").value;
  if (!isNonNegativeSafeInteger(written)) return null;
  if (written !== request.itemCount) return null;

  return { jobId: jobId.toLowerCase(), jobGeneration, written };
}

/** The receipt of one progress record. */
export interface ProgressReceipt {
  readonly jobId: string;
  readonly jobGeneration: number;
  readonly recorded: number | null;
  readonly inventory: boolean;
}

/**
 * Parses the progress receipt and binds it to the request.
 *
 * The accepted SQL answers an operations record with a count and an inventory
 * record with the literal `recorded`. Both must name the same job and
 * generation as the request.
 */
export function parseProgressReceipt(
  value: unknown,
  request: { readonly jobId: string; readonly jobGeneration: number },
): ProgressReceipt | null {
  if (!isPlainRecord(value)) return null;

  const jobId = readOwnData(value, "job_id").value;
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;

  const jobGeneration = readOwnData(value, "job_generation").value;
  if (jobGeneration !== request.jobGeneration) return null;

  const inventory = readOwnData(value, "inventory").value;
  if (inventory !== undefined) {
    if (!hasExactKeys(value, PROGRESS_INVENTORY_KEYS)) return null;
    if (inventory !== "recorded") return null;
    return { jobId: jobId.toLowerCase(), jobGeneration, recorded: null, inventory: true };
  }

  if (!hasExactKeys(value, PROGRESS_OPERATIONS_KEYS)) return null;
  const recorded = readOwnData(value, "recorded").value;
  if (!isNonNegativeSafeInteger(recorded)) return null;
  return { jobId: jobId.toLowerCase(), jobGeneration, recorded, inventory: false };
}

/** The receipt of one completion. */
export interface CompleteReceipt {
  readonly jobId: string;
  readonly jobGeneration: number;
  readonly status: OwnerJobStatus;
  readonly outcome: OwnerJobOutcome;
  readonly reasonCode: string | null;
}

/**
 * Parses the completion receipt and binds it to the request.
 *
 * The status the database reports must be the status the requested outcome
 * produces, and the reason code must be the one that was sent. A receipt
 * that disagrees is not evidence that the job was closed as asked.
 */
export function parseCompleteReceipt(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
    readonly outcome: OwnerJobOutcome;
    readonly reasonCode: string | null;
  },
): CompleteReceipt | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, COMPLETE_KEYS)) return null;

  const jobId = readOwnData(value, "job_id").value;
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;

  const jobGeneration = readOwnData(value, "job_generation").value;
  if (jobGeneration !== request.jobGeneration) return null;

  const outcome = readOwnData(value, "outcome").value;
  if (!isJobOutcome(outcome)) return null;
  if (outcome !== request.outcome) return null;

  const status = readOwnData(value, "status").value;
  if (!isJobStatus(status)) return null;
  if (status !== outcome) return null;

  const reasonCode = readOwnData(value, "reason_code").value;
  if (reasonCode !== request.reasonCode) return null;
  if (reasonCode !== null && !isReasonCode(reasonCode)) return null;

  return {
    jobId: jobId.toLowerCase(),
    jobGeneration,
    status,
    outcome,
    reasonCode: reasonCode === null ? null : (reasonCode as string),
  };
}

/**
 * Parses the throttle receipt.
 *
 * A null or partial receipt is not proof the shared backoff was stored. A
 * job-scoped throttle must answer for that job and report it parked; a
 * bucket-scoped throttle must answer with a null job.
 */
export function parseThrottleReceipt(
  value: unknown,
  request: {
    readonly bucketKey: string;
    readonly jobId: string | null;
    readonly throttledUntil: string | null;
  },
): boolean {
  if (!isPlainRecord(value)) return false;

  const bucketKey = readOwnData(value, "bucket_key").value;
  if (bucketKey !== request.bucketKey) return false;
  if (typeof bucketKey !== "string" || !BUCKET_KEY_PATTERN.test(bucketKey)) return false;

  const usage = readOwnData(value, "usage_percent").value;
  if (usage !== null && !isNonNegativeSafeInteger(usage)) return false;

  const throttledUntil = readOwnData(value, "throttled_until").value;
  if (!isNullableTimestamp(throttledUntil)) return false;
  if (request.throttledUntil !== null && throttledUntil !== request.throttledUntil) return false;

  const jobId = readOwnData(value, "job_id").value;

  if (request.jobId === null) {
    return hasExactKeys(value, THROTTLE_BUCKET_KEYS) && jobId === null;
  }

  return hasExactKeys(value, THROTTLE_PARKED_KEYS) &&
    isUuidText(jobId) &&
    sameUuid(jobId, request.jobId) &&
    readOwnData(value, "status").value === "retry";
}

// ---------------------------------------------------------------------------
// The provider permit
// ---------------------------------------------------------------------------

/**
 * The exact key sets of the provider permit.
 *
 * The permit is a closed projection built by `jsonb_build_object`, so an
 * extra key means a different deployment and a missing key means the answer
 * is not the permit. Both are refused instead of being read loosely.
 */
const PROVIDER_PERMIT_ALLOWED_KEYS = [
  "allowed",
  "job_id",
  "target_kind",
  "target_id",
  "viewer_social_account_id",
  "job_generation",
  "credential_generation",
  "policy_fingerprint",
] as const;

const PROVIDER_PERMIT_REFUSED_KEYS = ["allowed", "reason_code"] as const;

/**
 * The refusal reasons the accepted SQL returns.
 *
 * The set is closed. An unknown reason is NOT a refusal this contract
 * knows: it is unavailable, never permission. A reason that is not in this
 * list can never turn into a provider request.
 */
export const PROVIDER_PERMIT_REFUSAL_REASONS = [
  "invalid_request",
  "job_not_found",
  "claim_stale",
  "credential_changed",
  "target_inactive",
  "context_missing",
  "context_unusable",
  "collection_not_eligible",
  "collection_disabled",
  "settings_unavailable",
  "not_authorized",
] as const;

export type ProviderPermitRefusalReason =
  (typeof PROVIDER_PERMIT_REFUSAL_REASONS)[number];

export function isProviderPermitRefusalReason(
  value: unknown,
): value is ProviderPermitRefusalReason {
  return typeof value === "string" &&
    (PROVIDER_PERMIT_REFUSAL_REASONS as readonly string[]).includes(value);
}

/** The SHA-256 fingerprint of the policy document. Audit evidence only. */
const POLICY_FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;

/** A granted permit. */
export interface AllowedProviderPermit {
  readonly allowed: true;
  readonly jobId: string;
  readonly targetKind: string;
  readonly targetId: string;
  readonly viewerSocialAccountId: string | null;
  readonly jobGeneration: number;
  readonly credentialGeneration: number | null;
  /** The server-computed policy fingerprint. It is never an authorization token. */
  readonly policyFingerprint: string | null;
}

/** A refused permit. */
export interface RefusedProviderPermit {
  readonly allowed: false;
  readonly reasonCode: ProviderPermitRefusalReason;
}

export type ProviderPermit = AllowedProviderPermit | RefusedProviderPermit;

/**
 * Parses the provider permit and binds it to the request.
 *
 * The permit must name the SAME job and the SAME generation the request
 * asked for: a permit for another job is not evidence that THIS job may
 * spend a provider call.
 *
 * A malformed answer, an extra key, a missing key, a mismatched identity
 * and an unknown reason are ALL unavailable. None of them is permission.
 */
export function parseProviderPermit(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly jobGeneration: number;
  },
): ProviderPermit | null {
  if (!isPlainRecord(value)) return null;

  const allowed = readOwnData(value, "allowed");
  if (!allowed.present || typeof allowed.value !== "boolean") return null;

  if (allowed.value === false) {
    if (!hasExactKeys(value, PROVIDER_PERMIT_REFUSED_KEYS)) return null;
    const reasonCode = readOwnData(value, "reason_code").value;
    if (!isProviderPermitRefusalReason(reasonCode)) return null;
    return { allowed: false, reasonCode };
  }

  if (!hasExactKeys(value, PROVIDER_PERMIT_ALLOWED_KEYS)) return null;

  const jobId = readOwnData(value, "job_id").value;
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;

  const jobGeneration = readOwnData(value, "job_generation").value;
  if (!isPositiveSafeInteger(jobGeneration)) return null;
  if (jobGeneration !== request.jobGeneration) return null;

  const targetKind = readOwnData(value, "target_kind").value;
  if (targetKind !== "owner") return null;

  const targetId = readOwnData(value, "target_id").value;
  if (!isUuidText(targetId)) return null;

  const viewer = readOwnData(value, "viewer_social_account_id").value;
  if (viewer !== null && !isUuidText(viewer)) return null;

  const credentialGeneration = readOwnData(value, "credential_generation").value;
  if (credentialGeneration !== null && !isPositiveSafeInteger(credentialGeneration)) {
    return null;
  }

  const fingerprint = readOwnData(value, "policy_fingerprint").value;
  if (fingerprint !== null && !isPolicyFingerprint(fingerprint)) return null;

  return {
    allowed: true,
    jobId: jobId.toLowerCase(),
    targetKind,
    targetId: targetId.toLowerCase(),
    viewerSocialAccountId: viewer === null ? null : (viewer as string).toLowerCase(),
    jobGeneration,
    credentialGeneration: credentialGeneration as number | null,
    policyFingerprint: fingerprint === null ? null : (fingerprint as string),
  };
}

function isPolicyFingerprint(value: unknown): value is string {
  return typeof value === "string" && POLICY_FINGERPRINT_PATTERN.test(value);
}

// ---------------------------------------------------------------------------
// The direct credential
// ---------------------------------------------------------------------------

/**
 * The operational credential of a DIRECT Instagram login.
 *
 * The token is carried here and nowhere else: it is never logged, never
 * returned to a client and never serialised into a summary.
 */
export interface DirectOwnerCredential {
  readonly jobId: string;
  readonly userId: string;
  readonly socialAccountId: string;
  /** The canonical Instagram user id the provider endpoints are addressed to. */
  readonly igUserId: string;
  readonly loginKind: "direct";
  readonly credentialGeneration: number;
  readonly accessToken: string;
  readonly tokenExpiresAt: string | null;
}

/**
 * Parses the direct credential answer and binds it to the request.
 *
 * The answer must name the same job, the same account and the same
 * credential generation the request asked for, must classify the login as
 * `direct`, and must carry a non-empty operational token. Anything else is
 * indeterminate: the caller abandons the job to its lease rather than
 * spending a provider call on a credential it cannot vouch for.
 *
 * The expiry is explicit about being unknown: a null expiry is a valid
 * answer (the provider may not state one) and is never a failure, and a
 * malformed expiry is a refusal.
 */
export function parseDirectOwnerCredential(
  value: unknown,
  request: {
    readonly jobId: string;
    readonly socialAccountId: string;
    readonly credentialGeneration: number;
  },
): DirectOwnerCredential | null {
  if (!isPlainRecord(value) || !hasExactKeys(value, DIRECT_CREDENTIAL_KEYS)) return null;

  const jobId = readOwnData(value, "job_id").value;
  if (!isUuidText(jobId) || !sameUuid(jobId, request.jobId)) return null;

  const userId = readOwnData(value, "user_id").value;
  if (!isUuidText(userId)) return null;

  const socialAccountId = readOwnData(value, "social_account_id").value;
  if (!isUuidText(socialAccountId) || !sameUuid(socialAccountId, request.socialAccountId)) {
    return null;
  }

  const igUserId = readOwnData(value, "ig_user_id").value;
  if (typeof igUserId !== "string" || igUserId.trim() === "" || igUserId.length > 255) {
    return null;
  }

  const loginKind = readOwnData(value, "login_kind").value;
  if (loginKind !== "direct") return null;

  const credentialGeneration = readOwnData(value, "credential_generation").value;
  if (!isPositiveSafeInteger(credentialGeneration)) return null;
  if (credentialGeneration !== request.credentialGeneration) return null;

  const accessToken = readOwnData(value, "access_token").value;
  if (typeof accessToken !== "string" || accessToken.trim() === "") return null;

  const tokenExpiresAt = readOwnData(value, "token_expires_at").value;
  if (!isNullableTimestamp(tokenExpiresAt)) return null;

  return {
    jobId: jobId.toLowerCase(),
    userId: userId.toLowerCase(),
    socialAccountId: socialAccountId.toLowerCase(),
    igUserId,
    loginKind: "direct",
    credentialGeneration,
    accessToken,
    tokenExpiresAt,
  };
}
