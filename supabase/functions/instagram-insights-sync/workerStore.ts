/**
 * The service-role database adapter of the OWNER collection worker.
 *
 * WHAT THIS MODULE OWNS
 *
 *   Every database access the worker makes: the service RPCs of the accepted
 *   migration `20261026150000_instagram_durable_collection_jobs.sql`, the
 *   owner-scoped service reads it needs, and the strict validation of what
 *   the database actually returned.
 *
 * WHY A FAILED READ IS NEVER AN EMPTY ONE
 *
 *   The driver envelope is read by its own descriptors. A missing `error` is
 *   a malformed envelope, not a success; an explicit `null` error is the
 *   only completed read. A driver error is classified by its SQLSTATE and
 *   the MESSAGE IS DROPPED: a PostgREST message can quote SQL, a table name
 *   or an id.
 *
 * WHY THE TOKEN IS NEVER READ FROM `social_accounts`
 *
 *   The account row's `access_token` is readable by the browser roles, so
 *   it is not an authority and this module never reads it.
 *
 *   A Facebook-login account's token comes from the protected credential
 *   adapter, which is the only authority for a Facebook User token. A
 *   DIRECT-login account has no protected binding at all, so its token
 *   comes from the fenced direct reader instead: the database derives the
 *   owner and the target from the claimed job and returns the operational
 *   token only when the whole fence holds.
 *
 *   The trusted capability is read on its own, so a direct-login account is
 *   decided before any credential is looked for.
 *
 * WHY THE MEDIA INVENTORY IS READ BACK
 *
 *   The queue of pending media is persisted by the accepted checkpoint, and
 *   the metadata a media snapshot needs - the publication time, the product
 *   type and the text the provider already reported - is persisted with the
 *   media row. A queue that an earlier visit built is therefore read back
 *   from the rows that visit wrote, and the read is scoped to the account
 *   and to the capture day.
 *
 *   The same read carries the insight metrics this capture day already
 *   stored. The accepted upsert writes the EXCLUDED columns, so a metric
 *   that is not in the payload is nulled, and an inventory write for a
 *   media whose insights were already collected would wipe them.
 *
 * WHY EVERY RECEIPT IS BOUND TO ITS REQUEST
 *
 *   A receipt that names another job, another generation or another item
 *   count is not evidence that the write happened as asked. It is
 *   indeterminate, and the caller abandons the job to its lease rather than
 *   reporting a success.
 *
 * WHY THE PERMIT IS READ HERE AND NOT IN THE WORKER
 *
 *   The per-request admission gate is a DATABASE decision: the accepted SQL
 *   derives every identity from the live fenced job, checks the current
 *   policy and returns a typed permit or a typed refusal. This module is the
 *   adapter of that call, so it owns the strict parsing of the answer AND
 *   the exception-path audit: a normal refusal is audited by the accepted
 *   SQL in the same committed transaction, and a permit that could not be
 *   read at all never reached that audit, so this module writes the row in a
 *   separate bounded call and reports whether it committed.
 */

import {
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  CredentialStoreError,
} from "../_shared/facebookUserCredentialStore.ts";
import { isStaleCollectionSqlstate } from "./httpRpc.ts";

import {
  isPlainRecord,
  isTimestampText,
  parseClaimedOwnerJob,
  parseCompleteReceipt,
  parseDirectOwnerCredential,
  parseProgressReceipt,
  parseProviderPermit,
  parseSnapshotReceipt,
  parseThrottleReceipt,
  readOwnData,
  type AllowedProviderPermit,
  type ClaimedOwnerJob,
  type CompleteReceipt,
  type DirectOwnerCredential,
  type OwnerJobOutcome,
  type ProgressReceipt,
  type ProviderPermitRefusalReason,
  type SnapshotReceipt,
} from "./receipts.ts";

/**
 * The narrow write surface of the service client.
 *
 * The ONLY row this feature writes directly is the EXCEPTION-PATH audit row:
 * a refusal the database could not audit itself, because the statement never
 * reached it. A normal refusal is audited by the accepted SQL in the same
 * committed transaction, and this port is not used for it.
 */
export interface OwnerServiceWritePort {
  /**
   * Writes one sanitized audit row.
   *
   * It answers whether the row COMMITTED. A failed write is false, never a
   * stored row, and the caller stops the work and reports the audit failure.
   */
  insertSystemLog(row: OwnerSystemLogRow): Promise<boolean>;
}

/** One bounded, sanitized audit row. It never carries a token or a header. */
export interface OwnerSystemLogRow {
  readonly source: string;
  readonly category: string;
  readonly level: string;
  readonly message: string;
  readonly userId: string | null;
  readonly metadata: Record<string, unknown>;
}

/**
 * The outcome of the per-request admission gate.
 *
 *   allowed      the permit was granted for THIS job and generation.
 *   refused      the database refused the call. Its own audit row committed
 *                with the refusal, so nothing is written here.
 *   unavailable  the permit could not be read at all, so the outcome is
 *                UNKNOWN. The exception-path audit row is attempted in a
 *                separate bounded call, and `auditStored` says whether it
 *                committed.
 */
export type ProviderPermitDecision =
  | { readonly kind: "allowed"; readonly permit: AllowedProviderPermit }
  | { readonly kind: "refused"; readonly reasonCode: ProviderPermitRefusalReason }
  | {
    readonly kind: "unavailable";
    readonly reasonCode: string;
    readonly auditStored: boolean;
  };

/** The tables this feature reads with the service role. */
export type OwnerServiceTable =
  | "social_accounts"
  | "instagram_provider_throttle_buckets"
  | "ig_media_insight_snapshots";

/**
 * The narrow read surface of the service client.
 *
 * The table name is a closed union, so a dynamic table name cannot be
 * smuggled in, and every read is owner-scoped by its filters.
 */
export interface OwnerServiceReadPort {
  readOne(
    table: OwnerServiceTable,
    columns: string,
    filters: Record<string, unknown>,
  ): Promise<unknown>;
  /**
   * The same, for a bounded list of rows.
   *
   * The id column and the ids are named by the caller and the table name is
   * still the closed union, so the read stays as narrow as the single-row
   * read. It is used to recover the media metadata of a queue that was
   * persisted by an earlier visit.
   */
  readMany(
    table: OwnerServiceTable,
    columns: string,
    filters: Record<string, unknown>,
    idColumn: string,
    ids: readonly string[],
  ): Promise<unknown>;
}

/**
 * The service RPC caller.
 *
 * The result is `unknown` because the driver envelope is untrusted.
 */
export type OwnerServiceRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<unknown>;

/**
 * How a store call failed.
 *
 *   forbidden            - the database refused the caller's role.
 *   not_found            - the database refused the target.
 *   stale_claim          - the lease or the generation moved on.
 *   invalid              - a definitive refusal of the request shape.
 *   schema_unavailable   - the accepted functions are not deployed.
 *   credential_missing   - the account owns no protected credential.
 *   credential_changed   - the credential was replaced under the attempt.
 *   invalid_envelope     - the driver envelope was malformed.
 *   rpc_failed           - anything else. The write may have committed.
 */
export type OwnerStoreFailure =
  | "forbidden"
  | "not_found"
  | "stale_claim"
  | "invalid"
  | "schema_unavailable"
  | "credential_missing"
  | "credential_changed"
  | "invalid_envelope"
  | "rpc_failed";

export class OwnerWorkerStoreError extends Error {
  readonly failure: OwnerStoreFailure;
  readonly sqlstate: string | null;

  constructor(failure: OwnerStoreFailure, sqlstate: string | null = null) {
    // The message is deliberately generic. A SQL error text can quote a
    // target, an owner or a statement, and it never reaches a client or a
    // log.
    super("The Instagram collection store could not complete the operation.");
    this.name = "OwnerWorkerStoreError";
    this.failure = failure;
    this.sqlstate = sqlstate;
  }
}

/**
 * Maps a driver error onto a stable failure kind.
 *
 * Only the SQLSTATE is read. The message is never copied.
 */
function classifyDriverError(error: unknown): OwnerWorkerStoreError {
  if (!isPlainRecord(error)) {
    return new OwnerWorkerStoreError("rpc_failed");
  }

  const code = readOwnData(error, "code");
  const sqlstate = code.present && typeof code.value === "string" ? code.value : null;

  if (sqlstate === "42501") return new OwnerWorkerStoreError("forbidden", sqlstate);
  if (sqlstate === "P0002") return new OwnerWorkerStoreError("not_found", sqlstate);
  if (isStaleCollectionSqlstate(sqlstate)) return new OwnerWorkerStoreError("stale_claim", sqlstate);
  if (sqlstate === "22023" || sqlstate === "23514" || sqlstate === "23505") {
    return new OwnerWorkerStoreError("invalid", sqlstate);
  }
  if (sqlstate === "PGRST202" || sqlstate === "42883") {
    return new OwnerWorkerStoreError("schema_unavailable", sqlstate);
  }

  return new OwnerWorkerStoreError("rpc_failed", sqlstate);
}

/**
 * Reads the payload of a completed call.
 *
 * A missing `error` property is a malformed envelope and is a failure: it is
 * never read as a completed read. Both own data descriptors are validated
 * BEFORE any SQLSTATE is trusted, and getters are never invoked.
 */
function readCompletedData(envelope: unknown): unknown {
  if (!isPlainRecord(envelope)) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }

  const error = readOwnData(envelope, "error");
  const data = readOwnData(envelope, "data");
  if (!error.present || !data.present) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }
  if (error.value !== null) {
    throw classifyDriverError(error.value);
  }

  return data.value;
}

async function callRpc(
  rpc: OwnerServiceRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let envelope: unknown;
  try {
    envelope = await rpc(functionName, args, signal);
  } catch (error) {
    if (error instanceof OwnerWorkerStoreError) throw error;
    throw new OwnerWorkerStoreError("rpc_failed");
  }
  return readCompletedData(envelope);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = readOwnData(record, key);
  if (!value.present || typeof value.value !== "string" || value.value.length === 0) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }
  return value.value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = readOwnData(record, key);
  if (!value.present || value.value === null || value.value === undefined) return null;
  if (typeof value.value !== "string") {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }
  return value.value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = readOwnData(record, key);
  if (!value.present || value.value === null || value.value === undefined) return null;
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }
  return value.value;
}

/** The target account of an owner job, as the database holds it. */
export interface OwnerTarget {
  readonly socialAccountId: string;
  readonly userId: string;
  /** The Instagram user id the Graph insights edge is addressed to. */
  readonly platformUserId: string;
}

/** The protected credential of an owner account. */
export interface ResolvedOwnerCredential {
  /** The token. It is never logged, returned or serialised. */
  readonly token: string;
  /** The protected credential id. The bucket key is a digest of it. */
  readonly credentialId: string;
  /** The credential generation the credential was read at. */
  readonly capabilityGeneration: number;
  /**
   * The expiry the protected authority reported, or null when it reported
   * none.
   *
   * Readiness is not presence: a KNOWN expired credential is not ready, and
   * a null expiry is unknown rather than expired.
   */
  readonly tokenExpiresAt: string | null;
}

/**
 * The trusted capability of an owner account.
 *
 * It is the row the accepted SQL reads for the claim, and it is the only
 * authority for the login kind. The worker reads it BEFORE the protected
 * credential, so a direct-login account is decided without a credential
 * read and without a provider call.
 *
 * The scope set is authoritative only when the permission read succeeded:
 * an unknown scope set is not a denial, and it is never read as one.
 */
export interface OwnerCapability {
  readonly loginKind: "direct" | "page_linked";
  readonly credentialGeneration: number;
  /** True when the stored scope set is authoritative. */
  readonly scopesAuthoritative: boolean;
  /** The granted scopes. Authoritative only when `scopesAuthoritative`. */
  readonly grantedScopes: readonly string[];
}

/**
 * The inventory metadata of one media row, as the database holds it.
 *
 * It is the metadata the accepted snapshot writer cannot receive from the
 * provider again: the publication time is required by every media snapshot,
 * and the product type decides which metrics exist for that media.
 *
 * It also carries the insight metrics this capture day already stored. The
 * accepted upsert writes the EXCLUDED columns, so a metric that is not in
 * the payload is nulled - and an inventory write for a media whose insights
 * were already collected would wipe them. The stored metrics are therefore
 * read back and carried over.
 */
export interface OwnerMediaInventoryRow {
  readonly igMediaId: string;
  readonly mediaProductType: string | null;
  readonly mediaType: string | null;
  readonly publishedAt: string;
  readonly likeCountPublic: number | null;
  readonly commentsCountPublic: number | null;
  readonly permalink: string | null;
  readonly caption: string | null;
  readonly thumbnailUrl: string | null;
  /** The status the row was stored with. */
  readonly status: "ok" | "unavailable";
  readonly views: number | null;
  readonly reach: number | null;
  readonly likes: number | null;
  readonly comments: number | null;
  readonly saved: number | null;
  readonly shares: number | null;
  readonly totalInteractions: number | null;
  readonly follows: number | null;
  readonly profileVisits: number | null;
  readonly replies: number | null;
  readonly igReelsAvgWatchTimeMs: number | null;
}

/** The shared throttle bucket state of a credential. */
export interface OwnerThrottleBucket {
  readonly usagePercent: number | null;
  readonly throttledUntil: string | null;
}

/** The snapshot payload kinds the accepted SQL accepts for an owner job. */
export type OwnerSnapshotKind =
  | "owner_profile_observation"
  | "owner_account_day"
  | "owner_media";

export interface OwnerSnapshotPayload {
  readonly kind: OwnerSnapshotKind;
  readonly items: readonly Record<string, unknown>[];
}

/** The inventory progress payload the accepted SQL accepts. */
export interface OwnerInventoryProgressPayload {
  readonly kind: "inventory";
  readonly cursor: string | null;
  readonly remaining_ids: readonly string[];
  readonly pages_fetched: number;
  readonly oldest_returned_at: string | null;
  readonly window_start: string;
  readonly window_end: string;
  readonly partial: boolean;
  readonly truncated: boolean;
  readonly window_covered: boolean;
  readonly gap_reason: string | null;
}

/**
 * One planned operation of the accepted operations contract.
 *
 * The accepted SQL records it in the job's operation table, where a
 * `pending` or `failed` operation keeps the job claimable and blocks a
 * `completed` completion. It is how a planned day that did not fit the
 * budget survives the visit that planned it.
 */
export interface OwnerOperationProgressItem {
  readonly operation_key: string;
  readonly operation_kind: "media" | "account_day" | "profile";
  readonly state: "pending" | "failed";
  readonly provider_date?: string | null;
  readonly query_kind?: string | null;
  readonly reason_code?: string | null;
  readonly retry_at?: string | null;
}

/** The operations progress payload the accepted SQL accepts. */
export interface OwnerOperationsProgressPayload {
  readonly kind: "operations";
  readonly items: readonly OwnerOperationProgressItem[];
}

/** The progress payload the accepted SQL accepts. */
export type OwnerProgressPayload =
  | OwnerInventoryProgressPayload
  | OwnerOperationsProgressPayload;

/** The service-facing store of the owner collection worker. */
export interface OwnerCollectionServiceStore {
  claimOwnerJobs(input: {
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<ClaimedOwnerJob[]>;
  readOwnerTarget(input: {
    readonly socialAccountId: string;
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): Promise<OwnerTarget | null>;
  /**
   * The trusted capability of the account.
   *
   * It is read BEFORE the protected credential: a direct-login account has
   * no protected Facebook User credential, and the worker must decide that
   * from the capability alone.
   */
  readOwnerCapability(input: {
    readonly userId: string;
    readonly socialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<OwnerCapability>;
  resolveOwnerCredential(input: {
    readonly userId: string;
    readonly socialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<ResolvedOwnerCredential>;
  /**
   * The per-request admission permit.
   *
   * The database derives every identity from the LIVE fenced job, so this
   * call names the job, its claim token and its generation and NOTHING
   * else: it can never redirect the request to another owner, another
   * account or another viewer.
   *
   * The answer is a typed decision. A refusal is a refusal, a permit that
   * could not be read is UNAVAILABLE, and neither is ever permission.
   */
  authorizeProviderCall(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly signal?: AbortSignal;
  }): Promise<ProviderPermitDecision>;
  /**
   * The operational token of a DIRECT Instagram login.
   *
   * The database derives the owner and the target from the fenced job
   * alone, so this call carries no account or owner selector. The account
   * id is passed only to BIND the answer: a receipt that names another
   * account is not evidence that the read happened as asked.
   *
   * A credential generation that moved on refuses; the read never adopts
   * the current authority.
   */
  resolveDirectOwnerCredential(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly expectedCredentialGeneration: number;
    readonly socialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<DirectOwnerCredential>;
  /**
   * The inventory metadata of the queued media.
   *
   * The queue is persisted by the accepted checkpoint, but the metadata a
   * media snapshot needs is persisted with the media row. This read
   * recovers it for a queue that an earlier visit built.
   */
  readOwnerMediaInventory(input: {
    readonly socialAccountId: string;
    readonly capturedOn: string;
    readonly mediaIds: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<OwnerMediaInventoryRow[]>;
  readThrottleBucket(input: {
    readonly bucketKey: string;
    readonly signal?: AbortSignal;
  }): Promise<OwnerThrottleBucket | null>;
  persistSnapshot(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly payload: OwnerSnapshotPayload;
    readonly signal?: AbortSignal;
  }): Promise<SnapshotReceipt>;
  recordProgress(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly payload: OwnerProgressPayload;
    readonly signal?: AbortSignal;
  }): Promise<ProgressReceipt>;
  completeJob(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly outcome: OwnerJobOutcome;
    readonly reasonCode: string | null;
    readonly signal?: AbortSignal;
  }): Promise<CompleteReceipt>;
  recordThrottle(input: {
    readonly bucketKey: string;
    readonly usagePercent: number | null;
    readonly throttledUntil: string | null;
    readonly jobId?: string | null;
    readonly claimToken?: string | null;
    readonly jobGeneration?: number | null;
    readonly signal?: AbortSignal;
  }): Promise<void>;
}

export interface OwnerCollectionServiceStoreDeps {
  readonly rpc: OwnerServiceRpcCaller;
  readonly reads: OwnerServiceReadPort;
  /**
   * The narrow write surface. It is used for the EXCEPTION-PATH audit only:
   * a permit refusal the accepted SQL could not audit itself.
   */
  readonly writes: OwnerServiceWritePort;
}

/**
 * The SQLSTATEs of the direct credential reader.
 *
 *   IDC01  a required argument is missing
 *   IDC02  the job is not an owner job
 *   IDC03  the trusted capability is not a direct login
 *   IDC04  the credential generation moved on before the read
 *   IDC05  there is no usable operational token
 */
const DIRECT_CREDENTIAL_GENERATION_CODES = new Set(["IDC03", "IDC04"]);
const DIRECT_CREDENTIAL_MISSING_CODES = new Set(["IDC05"]);
const DIRECT_CREDENTIAL_REFUSED_CODES = new Set(["IDC01", "IDC02"]);

/**
 * Maps a direct-credential refusal onto a stable failure kind.
 *
 * The native `40001` and HTTP `PT409` of the accepted fence are folded into `credential_changed` on
 * purpose: for THIS reader a stale claim and a replaced connection are the
 * same outcome for the worker - this job may not be collected, and no other
 * job may be held up by it. Folding it here keeps that condition a
 * per-job one instead of a run-ending one.
 *
 * Only the SQLSTATE is read. The message is never copied.
 */
function classifyDirectCredentialError(error: unknown): OwnerWorkerStoreError {
  if (!isPlainRecord(error)) {
    return new OwnerWorkerStoreError("rpc_failed");
  }

  const code = readOwnData(error, "code");
  const sqlstate = code.present && typeof code.value === "string" ? code.value : null;

  if (sqlstate === "42501") return new OwnerWorkerStoreError("forbidden", sqlstate);
  if (sqlstate === "P0002") return new OwnerWorkerStoreError("not_found", sqlstate);
  if (isStaleCollectionSqlstate(sqlstate)) return new OwnerWorkerStoreError("credential_changed", sqlstate);

  if (sqlstate !== null && DIRECT_CREDENTIAL_GENERATION_CODES.has(sqlstate)) {
    return new OwnerWorkerStoreError("credential_changed", sqlstate);
  }
  if (sqlstate !== null && DIRECT_CREDENTIAL_MISSING_CODES.has(sqlstate)) {
    return new OwnerWorkerStoreError("credential_missing", sqlstate);
  }
  if (sqlstate !== null && DIRECT_CREDENTIAL_REFUSED_CODES.has(sqlstate)) {
    return new OwnerWorkerStoreError("invalid", sqlstate);
  }
  if (sqlstate === "PGRST202" || sqlstate === "42883") {
    return new OwnerWorkerStoreError("schema_unavailable", sqlstate);
  }

  return new OwnerWorkerStoreError("rpc_failed", sqlstate);
}

/**
 * Reads the payload of the direct credential call.
 *
 * The envelope is read by its own descriptors, exactly like every other
 * read in this module: a missing `error` is a malformed envelope and not a
 * success, and an explicit null error is the only completed read.
 */
async function callDirectCredentialRpc(
  rpc: OwnerServiceRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  let envelope: unknown;
  try {
    envelope = await rpc(functionName, args, signal);
  } catch (error) {
    if (error instanceof OwnerWorkerStoreError) throw error;
    throw new OwnerWorkerStoreError("rpc_failed");
  }

  if (!isPlainRecord(envelope)) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }

  const error = readOwnData(envelope, "error");
  const data = readOwnData(envelope, "data");
  if (!error.present || !data.present) {
    throw new OwnerWorkerStoreError("invalid_envelope");
  }
  if (error.value !== null) {
    throw classifyDirectCredentialError(error.value);
  }

  return data.value;
}

/**
 * Maps a protected-credential refusal onto a store failure.
 *
 * The credential adapter already classifies the driver error; its message is
 * never copied.
 */
function mapCredentialError(error: unknown): OwnerWorkerStoreError {
  if (error instanceof CredentialStoreError) {
    if (error.code === "not_found") {
      return new OwnerWorkerStoreError("credential_missing", error.sqlstate);
    }
    if (error.code === "stale_version") {
      return new OwnerWorkerStoreError("credential_changed", error.sqlstate);
    }
    if (error.code === "schema_unavailable") {
      return new OwnerWorkerStoreError("schema_unavailable", error.sqlstate);
    }
    if (error.code === "refused") {
      return new OwnerWorkerStoreError("forbidden", error.sqlstate);
    }
    return new OwnerWorkerStoreError("rpc_failed", error.sqlstate);
  }
  return new OwnerWorkerStoreError("rpc_failed");
}

/**
 * The permit call's envelope.
 *
 * A completed read is a plain record with an own `error` that is exactly
 * null and an own `data`. Everything else - a missing field, a driver error,
 * a thrown transport failure - is UNREADABLE: the outcome of the admission
 * decision is unknown, and it is never permission.
 */
type PermitEnvelope =
  | { readonly kind: "read"; readonly data: unknown }
  | { readonly kind: "unreadable"; readonly reasonCode: string };

/**
 * Reads the permit call's envelope.
 *
 * Only the SQLSTATE is read, and only to tell a schema that is not deployed
 * from an operational failure. The message is never copied.
 */
async function readPermitEnvelope(
  rpc: OwnerServiceRpcCaller,
  input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly signal?: AbortSignal;
  },
): Promise<PermitEnvelope> {
  let envelope: unknown;
  try {
    envelope = await rpc(
      "authorize_instagram_collection_provider_call",
      {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_job_generation: input.jobGeneration,
      },
      input.signal,
    );
  } catch {
    // A thrown transport failure never reached the accepted SQL, so the
    // statement may or may not have run. It is a failure, never a permit.
    return { kind: "unreadable", reasonCode: "permit_read_failed" };
  }

  if (!isPlainRecord(envelope)) {
    return { kind: "unreadable", reasonCode: "malformed_envelope" };
  }

  const error = readOwnData(envelope, "error");
  const data = readOwnData(envelope, "data");
  if (!error.present || !data.present) {
    return { kind: "unreadable", reasonCode: "malformed_envelope" };
  }

  if (error.value !== null) {
    const code = isPlainRecord(error.value)
      ? readOwnData(error.value, "code").value
      : undefined;
    const sqlstate = typeof code === "string" ? code : null;
    if (sqlstate === "PGRST202" || sqlstate === "42883") {
      // The accepted migration is not deployed. The gate is unavailable, so
      // it fails closed: no provider request is authorized without it.
      return { kind: "unreadable", reasonCode: "schema_unavailable" };
    }
    return { kind: "unreadable", reasonCode: "permit_read_failed" };
  }

  return { kind: "read", data: data.value };
}

/**
 * Writes the EXCEPTION-PATH audit row.
 *
 * The accepted SQL audits a NORMAL refusal in the same committed
 * transaction. This row is for the refusal that never reached that audit:
 * the permit could not be read at all. It is bounded and sanitized - an
 * event, a reason code and the job id - and it never carries a token, a
 * claim token, a policy list or a provider payload.
 *
 * It answers whether the row COMMITTED. A failed write is never reported as
 * a stored row.
 */
async function auditProviderRefusal(
  writes: OwnerServiceWritePort,
  jobId: string,
  reasonCode: string,
): Promise<boolean> {
  try {
    return await writes.insertSystemLog({
      source: "instagram-collection-rollout",
      category: "database",
      level: "warn",
      message: "Instagram collection provider call refused",
      userId: null,
      metadata: {
        event: "collection_provider_call_refused",
        reason_code: reasonCode,
        job_id: jobId,
        action: "authorize_provider_call",
      },
    });
  } catch {
    return false;
  }
}

/**
 * The service store.
 *
 * It is the only place that speaks to the database for the worker, and it
 * speaks with the service role: the accepted worker RPCs are service-only
 * and they re-derive the owner from the target row.
 */
export function createOwnerCollectionServiceStore(
  deps: OwnerCollectionServiceStoreDeps,
): OwnerCollectionServiceStore {
  const readCompleted = async (envelope: unknown): Promise<unknown> =>
    readCompletedData(envelope);

  return {
    async claimOwnerJobs(input) {
      const data = await callRpc(
        deps.rpc,
        "claim_instagram_collection_jobs",
        { p_target_kind: "owner", p_limit: input.limit },
        input.signal,
      );

      if (!Array.isArray(data)) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      const jobs: ClaimedOwnerJob[] = [];
      for (const entry of data) {
        const job = parseClaimedOwnerJob(entry);
        if (job === null) {
          // A claimed row that does not match the accepted projection is not
          // a row this worker may act on.
          throw new OwnerWorkerStoreError("invalid_envelope");
        }
        jobs.push(job);
      }
      return jobs;
    },

    async readOwnerTarget(input) {
      const envelope = await deps.reads.readOne(
        "social_accounts",
        "id, user_id, platform, platform_user_id, is_active, needs_reauth",
        {
          id: input.socialAccountId,
          user_id: input.userId,
          platform: "instagram",
        },
      );

      const row = await readCompleted(envelope);
      if (row === null || row === undefined) return null;

      if (!isPlainRecord(row)) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      const socialAccountId = requireString(row, "id");
      const userId = requireString(row, "user_id");
      const platform = requireString(row, "platform");

      if (
        socialAccountId.toLowerCase() !== input.socialAccountId.toLowerCase() ||
        userId.toLowerCase() !== input.userId.toLowerCase() ||
        platform !== "instagram"
      ) {
        // The read was owner-scoped, so a row that names another owner is a
        // contract violation, not a miss.
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      const platformUserId = optionalString(row, "platform_user_id");
      if (platformUserId === null || platformUserId === "") {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      return { socialAccountId, userId, platformUserId };
    },

    async readOwnerCapability(input) {
      const capabilityStore = createInstagramAccountCapabilityStore((name, args) =>
        deps.rpc(name, args, input.signal)
      );

      let capability;
      try {
        capability = await capabilityStore.readCapability({
          userId: input.userId,
          socialAccountId: input.socialAccountId,
        });
      } catch (error) {
        throw mapCredentialError(error);
      }

      if (capability.loginKind !== "direct" && capability.loginKind !== "page_linked") {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      const generation = capability.credentialGeneration;
      if (!Number.isFinite(generation) || generation < 1) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      return {
        loginKind: capability.loginKind,
        credentialGeneration: generation,
        scopesAuthoritative: capability.scopesAuthoritative,
        grantedScopes: [...capability.grantedScopes],
      };
    },

    async resolveOwnerCredential(input) {
      // The protected credential adapter is the only authority for a
      // Facebook User token. The account row's `access_token` is never read
      // here, and a direct-login Instagram account - which has no protected
      // binding - is refused instead of falling back to the
      // browser-readable column.
      const credentialStore = createFacebookUserCredentialStore((name, args) =>
        deps.rpc(name, args, input.signal)
      );

      let binding;
      try {
        binding = await credentialStore.readAccountCredential({
          userId: input.userId,
          socialAccountId: input.socialAccountId,
        });
      } catch (error) {
        throw mapCredentialError(error);
      }

      if (!binding.found) {
        // A missing binding is NOT an empty token. There is no fallback to
        // the browser-readable account column.
        throw new OwnerWorkerStoreError("credential_missing");
      }
      if (
        binding.credentialKind !== "facebook_user" ||
        !binding.token ||
        !binding.credentialId ||
        binding.revision === null
      ) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      if (binding.platform !== "instagram") {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      const generation = binding.capabilityGeneration;
      if (generation === null || !Number.isFinite(generation) || generation < 1) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      return {
        token: binding.token,
        credentialId: binding.credentialId,
        capabilityGeneration: generation,
        tokenExpiresAt: binding.tokenExpiresAt,
      };
    },

    async authorizeProviderCall(input) {
      const envelope = await readPermitEnvelope(deps.rpc, input);

      if (envelope.kind === "unreadable") {
        // The permit could not be read. The accepted SQL never saw this
        // call, so IT could not audit it either: the row is written here, in
        // a separate bounded call, and the answer says whether it committed.
        const auditStored = await auditProviderRefusal(
          deps.writes,
          input.jobId,
          envelope.reasonCode,
        );
        return {
          kind: "unavailable",
          reasonCode: envelope.reasonCode,
          auditStored,
        };
      }

      const permit = parseProviderPermit(envelope.data, {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
      });

      if (permit === null) {
        // The answer is not the projection this contract knows. It is
        // unavailable, never permission, and the refusal is audited here.
        const auditStored = await auditProviderRefusal(
          deps.writes,
          input.jobId,
          "malformed_envelope",
        );
        return {
          kind: "unavailable",
          reasonCode: "malformed_envelope",
          auditStored,
        };
      }

      if (!permit.allowed) {
        // The accepted SQL refused the call and audited it in the same
        // committed transaction. Nothing is written here.
        return { kind: "refused", reasonCode: permit.reasonCode };
      }

      return { kind: "allowed", permit };
    },

    async resolveDirectOwnerCredential(input) {
      // The database derives the owner and the target from the fenced job.
      // This call carries NO account or owner selector; the account id that
      // travels with the request is used only to bind the answer.
      const data = await callDirectCredentialRpc(
        deps.rpc,
        "read_instagram_direct_collection_credential",
        {
          p_job_id: input.jobId,
          p_claim_token: input.claimToken,
          p_job_generation: input.jobGeneration,
          p_expected_credential_generation: input.expectedCredentialGeneration,
        },
        input.signal,
      );

      const credential = parseDirectOwnerCredential(data, {
        jobId: input.jobId,
        socialAccountId: input.socialAccountId,
        credentialGeneration: input.expectedCredentialGeneration,
      });
      if (credential === null) {
        // The answer did not name this job, this account and this
        // credential generation. It is not evidence that the read happened
        // as asked.
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      return credential;
    },

    async readOwnerMediaInventory(input) {
      if (input.mediaIds.length === 0) return [];

      const envelope = await deps.reads.readMany(
        "ig_media_insight_snapshots",
        "ig_media_id, media_product_type, media_type, published_at, " +
          "like_count_public, comments_count_public, permalink, caption, thumbnail_url, " +
          "status, views, reach, likes, comments, saved, shares, total_interactions, " +
          "follows, profile_visits, replies, ig_reels_avg_watch_time_ms",
        {
          social_account_id: input.socialAccountId,
          captured_on: input.capturedOn,
        },
        "ig_media_id",
        input.mediaIds,
      );

      const rows = await readCompleted(envelope);
      if (!Array.isArray(rows)) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      const inventory: OwnerMediaInventoryRow[] = [];
      for (const row of rows) {
        if (!isPlainRecord(row)) {
          throw new OwnerWorkerStoreError("invalid_envelope");
        }

        const igMediaId = requireString(row, "ig_media_id");
        const publishedAt = requireString(row, "published_at");
        if (!isTimestampText(publishedAt)) {
          throw new OwnerWorkerStoreError("invalid_envelope");
        }

        const status = requireString(row, "status");
        if (status !== "ok" && status !== "unavailable") {
          throw new OwnerWorkerStoreError("invalid_envelope");
        }

        inventory.push({
          igMediaId,
          mediaProductType: optionalString(row, "media_product_type"),
          mediaType: optionalString(row, "media_type"),
          publishedAt,
          likeCountPublic: optionalNumber(row, "like_count_public"),
          commentsCountPublic: optionalNumber(row, "comments_count_public"),
          permalink: optionalString(row, "permalink"),
          caption: optionalString(row, "caption"),
          thumbnailUrl: optionalString(row, "thumbnail_url"),
          status,
          views: optionalNumber(row, "views"),
          reach: optionalNumber(row, "reach"),
          likes: optionalNumber(row, "likes"),
          comments: optionalNumber(row, "comments"),
          saved: optionalNumber(row, "saved"),
          shares: optionalNumber(row, "shares"),
          totalInteractions: optionalNumber(row, "total_interactions"),
          follows: optionalNumber(row, "follows"),
          profileVisits: optionalNumber(row, "profile_visits"),
          replies: optionalNumber(row, "replies"),
          igReelsAvgWatchTimeMs: optionalNumber(row, "ig_reels_avg_watch_time_ms"),
        });
      }

      return inventory;
    },

    async readThrottleBucket(input) {
      const envelope = await deps.reads.readOne(
        "instagram_provider_throttle_buckets",
        "bucket_key, usage_percent, throttled_until",
        { bucket_key: input.bucketKey },
      );

      const row = await readCompleted(envelope);
      if (row === null || row === undefined) return null;

      if (!isPlainRecord(row)) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }

      return {
        usagePercent: optionalNumber(row, "usage_percent"),
        throttledUntil: optionalString(row, "throttled_until"),
      };
    },

    async persistSnapshot(input) {
      const data = await callRpc(
        deps.rpc,
        "persist_instagram_collection_snapshot",
        {
          p_job_id: input.jobId,
          p_claim_token: input.claimToken,
          p_job_generation: input.jobGeneration,
          p_payload: {
            kind: input.payload.kind,
            items: input.payload.items,
          },
        },
        input.signal,
      );

      // The receipt must answer for THIS job, generation and item count.
      const receipt = parseSnapshotReceipt(data, {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        itemCount: input.payload.items.length,
      });
      if (receipt === null) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      return receipt;
    },

    async recordProgress(input) {
      const pPayload = input.payload.kind === "operations"
        ? {
          kind: "operations",
          items: input.payload.items.map((item) => ({
            operation_key: item.operation_key,
            operation_kind: item.operation_kind,
            state: item.state,
            provider_date: item.provider_date ?? null,
            query_kind: item.query_kind ?? null,
            reason_code: item.reason_code ?? null,
            retry_at: item.retry_at ?? null,
          })),
        }
        : {
          kind: "inventory",
          cursor: input.payload.cursor,
          remaining_ids: [...input.payload.remaining_ids],
          pages_fetched: input.payload.pages_fetched,
          oldest_returned_at: input.payload.oldest_returned_at,
          window_start: input.payload.window_start,
          window_end: input.payload.window_end,
          partial: input.payload.partial,
          truncated: input.payload.truncated,
          window_covered: input.payload.window_covered,
          gap_reason: input.payload.gap_reason,
        };

      const data = await callRpc(
        deps.rpc,
        "record_instagram_collection_job_progress",
        {
          p_job_id: input.jobId,
          p_claim_token: input.claimToken,
          p_job_generation: input.jobGeneration,
          p_payload: pPayload,
        },
        input.signal,
      );

      const receipt = parseProgressReceipt(data, {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
      });
      if (receipt === null) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      return receipt;
    },

    async completeJob(input) {
      const data = await callRpc(
        deps.rpc,
        "complete_instagram_collection_job",
        {
          p_job_id: input.jobId,
          p_claim_token: input.claimToken,
          p_job_generation: input.jobGeneration,
          p_outcome: input.outcome,
          p_reason_code: input.reasonCode,
        },
        input.signal,
      );

      const receipt = parseCompleteReceipt(data, {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        outcome: input.outcome,
        reasonCode: input.reasonCode,
      });
      if (receipt === null) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
      return receipt;
    },

    async recordThrottle(input) {
      const data = await callRpc(
        deps.rpc,
        "record_instagram_provider_throttle",
        {
          p_bucket_key: input.bucketKey,
          p_usage_percent: input.usagePercent,
          p_throttled_until: input.throttledUntil,
          p_job_id: input.jobId ?? null,
          p_claim_token: input.claimToken ?? null,
          p_job_generation: input.jobGeneration ?? null,
        },
        input.signal,
      );

      // A null or partial receipt is not proof the shared backoff was stored.
      if (
        !parseThrottleReceipt(data, {
          bucketKey: input.bucketKey,
          jobId: input.jobId ?? null,
          throttledUntil: input.throttledUntil,
        })
      ) {
        throw new OwnerWorkerStoreError("invalid_envelope");
      }
    },
  };
}
