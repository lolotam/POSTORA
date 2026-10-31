/**
 * The SQL adapter of the OWNER daily dispatch.
 *
 * WHAT THIS MODULE OWNS
 *
 *   One service RPC of the accepted migration
 *   `20261031091000_instagram_collection_daily_dispatch.sql`:
 *
 *     enqueue_instagram_collection_daily_page(p_target_kind, p_start)
 *
 *   The call names the KIND of the population and whether the call STARTS
 *   or RESUMES the day. It never names an owner, an account, a date, a
 *   limit or a cursor: the capture day is chosen by the database, the page
 *   size is a constant of the contract, and the continuation is the
 *   anti-join inside the statement.
 *
 * WHY THE RECEIPTS ARE PARSED, NOT CAST
 *
 *   The accepted SQL returns a closed projection. A receipt that has an
 *   extra key, a missing key, a null where the SQL never returns null, or
 *   a value outside the SQL's own domain is NOT a receipt: it is a
 *   deployment that no longer matches this contract. It is refused here,
 *   before it can reach a client or a log.
 *
 *   Every required property is read through its OWN DATA DESCRIPTOR. A
 *   descriptor that is an accessor is refused WITHOUT being invoked, so a
 *   driver result that carries a getter can never run code inside this
 *   process, and an inherited property can never become authority.
 *
 * WHY A REFUSAL IS NOT AN ERROR
 *
 *   The statement answers a DEFINITE refusal of the CONFIGURATION: the
 *   master switch is off, or the configuration cannot be read. That is a
 *   decision, not a failure, and the caller maps it to its own status.
 *
 *   A failed or unreadable reply is a FAILURE. The statement may have
 *   committed, so the outcome is indeterminate and it is never reported as
 *   a completion, as an empty page or as "everything was enqueued".
 *
 * WHAT THIS MODULE NEVER DOES
 *
 *   It never calls a provider, never reads a credential, never reads a job
 *   row and never writes anything but the one sweep page the RPC owns.
 */

import { isPlainRecord, readOwnData } from "./receipts.ts";

/** The target kind this adapter uses. It is fixed, not chosen by a caller. */
export const OWNER_DAILY_TARGET_KIND = "owner" as const;

/**
 * The page ceiling of the owner population.
 *
 * It mirrors the SQL constant. A receipt that carries another ceiling
 * belongs to another contract and is refused.
 */
export const OWNER_DAILY_PAGE_LIMIT = 25;

/** The states of one day's sweep. */
export const DAILY_SWEEP_STATUSES = [
  "pending",
  "completed",
  "expired",
  "absent",
] as const;

export type DailySweepStatus = (typeof DAILY_SWEEP_STATUSES)[number];

/**
 * The refusal reasons the accepted SQL returns for the CONFIGURATION.
 *
 * The set is closed. An unknown reason is NOT a refusal this contract
 * knows: the statement may have committed, so the outcome is indeterminate
 * and it is never reported as a refusal.
 */
export const DAILY_REFUSAL_REASONS = [
  "collection_disabled",
  "settings_unavailable",
] as const;

export type DailyEnqueueRefusalReason = (typeof DAILY_REFUSAL_REASONS)[number];

/** The exact key set of the accepted receipt. */
const ACCEPTED_KEYS = [
  "accepted",
  "target_kind",
  "captured_on",
  "sweep_status",
  "enqueued",
  "has_more",
  "page_limit",
  "scanned",
  "started",
  "resumed",
] as const;

/** The exact key set of the refusal receipt. */
const REFUSED_KEYS = [
  "accepted",
  "refused",
  "reason_code",
  "target_kind",
  "captured_on",
] as const;

const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * A real Gregorian calendar date in years 0001 to 9999.
 *
 * The arithmetic is deliberately not delegated to `Date`: JavaScript
 * normalises 30 February into March, and a normalised invalid day must be
 * refused rather than moved.
 */
function isGregorianCalendarDate(value: unknown): value is string {
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

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPositiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

/**
 * True when the record carries exactly the expected own keys and nothing
 * else. An unknown key is refused rather than dropped: a receipt that grew
 * a lease token or a provider message belongs to another contract.
 */
function hasExactKeys(record: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(record);
  if (keys.length !== expected.length) return false;
  return expected.every((key) => Object.hasOwn(record, key));
}

/** The accepted receipt of one bounded page. */
export interface OwnerDailyEnqueueReceipt {
  readonly targetKind: typeof OWNER_DAILY_TARGET_KIND;
  readonly capturedOn: string;
  readonly sweepStatus: DailySweepStatus;
  /** The rows THIS call inserted. It is never a count of collected targets. */
  readonly enqueued: number;
  readonly hasMore: boolean;
  readonly pageLimit: number;
  /** The candidates the bounded scan examined. */
  readonly scanned: number;
  /** Whether this call created or reopened the day's sweep. */
  readonly started: boolean;
  /** Whether this call continued an already pending sweep. */
  readonly resumed: boolean;
}

/**
 * The outcome of one bounded page.
 *
 *   accepted  the statement ran and the sweep state is known.
 *   refused   the configuration refuses. It is a decision, not a failure.
 */
export type OwnerDailyEnqueueOutcome =
  | { readonly kind: "accepted"; readonly receipt: OwnerDailyEnqueueReceipt }
  | {
    readonly kind: "refused";
    readonly reason: DailyEnqueueRefusalReason;
    readonly capturedOn: string;
  };

/**
 * How a store call failed.
 *
 *   schema_unavailable - the accepted migration is not deployed. The
 *                        outcome is unknown, and it is never a completion.
 *   forbidden          - the database refused the caller's role.
 *   rpc_failed         - anything else, including a timeout, a transport
 *                        failure and a receipt that does not match this
 *                        contract. The statement may have committed.
 */
export type OwnerDailyStoreFailure =
  | "schema_unavailable"
  | "forbidden"
  | "rpc_failed";

export class OwnerDailyEnqueueStoreError extends Error {
  readonly failure: OwnerDailyStoreFailure;

  constructor(failure: OwnerDailyStoreFailure) {
    // The message is deliberately generic. A SQL error text can quote a
    // target, an owner or a statement, and it never reaches a client.
    super("The Instagram daily enqueue could not be completed.");
    this.name = "OwnerDailyEnqueueStoreError";
    this.failure = failure;
  }
}

/**
 * The service RPC caller.
 *
 * The result is `unknown` because the driver envelope is untrusted.
 */
export type OwnerDailyRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

export interface OwnerDailyEnqueueStore {
  /**
   * Runs one bounded page.
   *
   * `start` is true for the daily dispatcher and false for the resume a
   * drain performs before it claims. A resume never starts a sweep.
   */
  enqueueDailyPage(input: {
    readonly start: boolean;
    readonly signal: AbortSignal;
  }): Promise<OwnerDailyEnqueueOutcome>;
}

function readErrorCode(error: unknown): string | null {
  if (!isPlainRecord(error)) return null;
  const code = readOwnData(error, "code");
  if (!code.present || typeof code.value !== "string") return null;
  return code.value;
}

/**
 * Maps a SQLSTATE onto the small failure vocabulary.
 *
 * PGRST202 and 42883 mean the accepted function is not deployed, 42501
 * means the role was refused. Everything else - including a missing
 * function, a transport failure and a timeout - is indeterminate: the
 * statement may have run.
 */
function classifyErrorCode(code: string | null): OwnerDailyStoreFailure {
  if (code === "PGRST202" || code === "42883") return "schema_unavailable";
  if (code === "42501") return "forbidden";
  return "rpc_failed";
}

/**
 * Parses the accepted receipt.
 *
 * The receipt is a closed projection, so every key is checked: a missing
 * key, an extra key, a null where the SQL never returns null and a value
 * outside the SQL's own domain are all refused.
 */
function parseAccepted(value: unknown): OwnerDailyEnqueueReceipt | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, ACCEPTED_KEYS)) return null;

  const accepted = readOwnData(value, "accepted");
  if (!accepted.present || accepted.value !== true) return null;

  const targetKind = readOwnData(value, "target_kind");
  if (!targetKind.present || targetKind.value !== OWNER_DAILY_TARGET_KIND) return null;

  const capturedOn = readOwnData(value, "captured_on");
  if (!capturedOn.present || !isGregorianCalendarDate(capturedOn.value)) return null;

  const sweepStatus = readOwnData(value, "sweep_status");
  if (!sweepStatus.present) return null;
  if (!(DAILY_SWEEP_STATUSES as readonly string[]).includes(sweepStatus.value as string)) {
    return null;
  }

  const enqueued = readOwnData(value, "enqueued");
  if (!enqueued.present || !isNonNegativeSafeInteger(enqueued.value)) return null;

  const hasMore = readOwnData(value, "has_more");
  if (!hasMore.present || typeof hasMore.value !== "boolean") return null;

  const pageLimit = readOwnData(value, "page_limit");
  if (!pageLimit.present || !isPositiveSafeInteger(pageLimit.value)) return null;
  if (pageLimit.value !== OWNER_DAILY_PAGE_LIMIT) return null;

  const scanned = readOwnData(value, "scanned");
  if (!scanned.present || !isNonNegativeSafeInteger(scanned.value)) return null;

  // The scan is bounded by the page limit. A receipt that claims more
  // candidates than the page can hold is not this contract's receipt.
  if (scanned.value > pageLimit.value) return null;

  const started = readOwnData(value, "started");
  if (!started.present || typeof started.value !== "boolean") return null;

  const resumed = readOwnData(value, "resumed");
  if (!resumed.present || typeof resumed.value !== "boolean") return null;

  // A call either STARTS the day or RESUMES it. It never does both, and a
  // call that did neither had nothing to do.
  if (started.value && resumed.value) return null;

  // The receipt must agree with itself. A completed sweep has no more
  // progress, and a pending one has more.
  if (sweepStatus.value === "completed" && hasMore.value) return null;
  if (sweepStatus.value === "pending" && !hasMore.value) return null;

  return {
    targetKind: OWNER_DAILY_TARGET_KIND,
    capturedOn: capturedOn.value,
    sweepStatus: sweepStatus.value as DailySweepStatus,
    enqueued: enqueued.value,
    hasMore: hasMore.value,
    pageLimit: pageLimit.value,
    scanned: scanned.value,
    started: started.value,
    resumed: resumed.value,
  };
}

/**
 * Parses the refusal receipt.
 *
 * A reason code this contract does not know is not a refusal: the
 * statement may have committed, so the outcome is indeterminate and it is
 * never reported as a refusal.
 */
function parseRefused(
  value: unknown,
): { readonly reason: DailyEnqueueRefusalReason; readonly capturedOn: string } | null {
  if (!isPlainRecord(value)) return null;
  if (!hasExactKeys(value, REFUSED_KEYS)) return null;

  const accepted = readOwnData(value, "accepted");
  if (!accepted.present || accepted.value !== false) return null;

  const refused = readOwnData(value, "refused");
  if (!refused.present || refused.value !== true) return null;

  const reasonCode = readOwnData(value, "reason_code");
  if (!reasonCode.present || typeof reasonCode.value !== "string") return null;
  if (!(DAILY_REFUSAL_REASONS as readonly string[]).includes(reasonCode.value)) return null;

  const targetKind = readOwnData(value, "target_kind");
  if (!targetKind.present || targetKind.value !== OWNER_DAILY_TARGET_KIND) return null;

  const capturedOn = readOwnData(value, "captured_on");
  if (!capturedOn.present || !isGregorianCalendarDate(capturedOn.value)) return null;

  return {
    reason: reasonCode.value as DailyEnqueueRefusalReason,
    capturedOn: capturedOn.value,
  };
}

/**
 * The owner daily enqueue store.
 *
 * It runs the accepted service RPC and turns its closed projection into a
 * typed outcome. It never decides eligibility, never computes a capture
 * day and never reads a job row.
 */
export function createOwnerDailyEnqueueStore(
  caller: OwnerDailyRpcCaller,
): OwnerDailyEnqueueStore {
  return {
    async enqueueDailyPage(input): Promise<OwnerDailyEnqueueOutcome> {
      let envelope: unknown;
      try {
        envelope = await caller(
          "enqueue_instagram_collection_daily_page",
          {
            p_target_kind: OWNER_DAILY_TARGET_KIND,
            p_start: input.start,
          },
          input.signal,
        );
      } catch {
        // A thrown transport failure never reached the accepted SQL, so the
        // statement may or may not have run. It is a failure, never a
        // completion and never an empty page.
        throw new OwnerDailyEnqueueStoreError("rpc_failed");
      }

      if (!isPlainRecord(envelope)) {
        throw new OwnerDailyEnqueueStoreError("rpc_failed");
      }

      const error = readOwnData(envelope, "error");
      const data = readOwnData(envelope, "data");
      if (!error.present || !data.present) {
        throw new OwnerDailyEnqueueStoreError("rpc_failed");
      }

      if (error.value !== null) {
        throw new OwnerDailyEnqueueStoreError(classifyErrorCode(readErrorCode(error.value)));
      }

      const accepted = parseAccepted(data.value);
      if (accepted) return { kind: "accepted", receipt: accepted };

      const refused = parseRefused(data.value);
      if (refused) {
        return { kind: "refused", reason: refused.reason, capturedOn: refused.capturedOn };
      }

      // A receipt that matches neither projection is not a receipt this
      // contract knows. The statement may have committed, so the caller is
      // told the outcome is indeterminate and is never told it succeeded.
      throw new OwnerDailyEnqueueStoreError("rpc_failed");
    },
  };
}
