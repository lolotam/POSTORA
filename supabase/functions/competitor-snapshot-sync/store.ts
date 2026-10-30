/**
 * The database adapter of the competitor collector.
 *
 * WHAT THIS MODULE OWNS
 *
 *   Every database access the feature makes: the owner RPCs, the service
 *   RPCs, the owner-scoped service reads and the strict validation of what
 *   the database actually returned.
 *
 * WHY A FAILED READ IS NEVER AN EMPTY ONE
 *
 *   The driver envelope is read by its own descriptors. A missing `error`
 *   is a malformed envelope, not a success; an explicit `null` error is the
 *   only completed read. A driver error is classified by its SQLSTATE and
 *   the message is dropped: a PostgREST message can quote SQL, a table
 *   name or an id.
 *
 * WHY THE OWNER PATH RUNS AS THE CALLER
 *
 *   The accepted owner RPCs derive the owner from `auth.uid()` and are
 *   explicitly revoked from the service role. The owner request therefore
 *   has to reach PostgreSQL with the CALLER's own bearer. The service
 *   path is the opposite: it uses the service role and it never carries a
 *   user id that it did not derive itself.
 *
 * WHY THE VIEWER PROJECTION IS BUILT HERE
 *
 *   The shared selector expects candidates shaped like a social account
 *   row, and it was written against browser-authored metadata. That
 *   metadata is NOT authority. This module reads the OWNED accounts and
 *   the PROTECTED capability rows, keeps only the accounts whose trusted
 *   login kind is page-linked, whose permission read succeeded and whose
 *   granted scopes include an insights scope, and then projects those
 *   server-verified fields onto the selector's shape.
 *
 *   The access token in the projection is a NON-SECRET SENTINEL. The
 *   selector refuses a candidate without one; the real credential is
 *   resolved separately, through the protected credential adapter, and it
 *   never passes through this projection.
 *
 * WHY THE ROLLOUT DECISION IS ASKED OF THE DATABASE
 *
 *   The accepted migration owns the admission: it decides which watchlist
 *   may be collected for, which viewer is approved for it, and whether a
 *   provider request may go out. This module is the ADAPTER of those
 *   decisions, so it never decides membership itself and never reads a
 *   policy list: it asks the job-scoped SQL and acts on the answer.
 *
 *   Two of those decisions are asked per job and one of them per request:
 *
 *     - the viewer attachment is the job-scoped decision that narrows the
 *       candidate set to the eligible candidates, and it is asked BEFORE
 *       the credential is resolved, so no token is read for a target the
 *       policy does not admit;
 *     - the provider permit is the per-request decision, and it is asked
 *       again immediately before every request that leaves the process.
 *
 * WHY THE EXCEPTION-PATH AUDIT IS WRITTEN HERE
 *
 *   A refusal that RETURNS is audited by the accepted SQL in the same
 *   committed transaction. A refusal that RAISES is not: the raise rolls
 *   the audit row back. The attachment refuses by raising, so this module
 *   writes that row in a separate bounded call after the rollback, and it
 *   reports whether the row COMMITTED.
 */

import {
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  CredentialStoreError,
} from "../_shared/facebookUserCredentialStore.ts";
import type { ViewerCandidate } from "../_shared/instagramDiscoveryViewer.ts";

import {
  isPlainRecord,
  isThrottleReceipt,
  parseEnqueueReceipt,
  parseEnqueueRefusal,
  parseOwnerStatus,
  parseCoverageResultReceipt,
  parseProviderPermit,
  readOwnData,
  type AllowedProviderPermit,
  type ProviderPermitRefusalReason,
} from "./receipts.ts";

import type {
  AttachedViewerContext,
  ClaimedCompetitorJob,
  CompetitorEnqueueOutcome,
  CompetitorResultPayload,
  DueCompetitorTarget,
  DueTargetCursor,
  OwnerStatusProjection,
  PersistResultReceipt,
  ResolvedViewerCredential,
  ThrottleBucketState,
} from "./types.ts";

/**
 * The narrow write surface of the service client.
 *
 * The ONLY row this feature writes directly is the EXCEPTION-PATH audit
 * row: a refusal the accepted SQL could not audit itself, because the
 * statement raised and the raise rolled its audit row back. A refusal that
 * RETURNS is audited by the accepted SQL in the same committed transaction
 * and never comes through here.
 */
export interface CompetitorServiceWritePort {
  /**
   * Writes one sanitized audit row.
   *
   * It answers whether the row COMMITTED. A failed write is false, never a
   * stored row, and the caller stops the work and reports the audit
   * failure.
   */
  insertSystemLog(row: CompetitorSystemLogRow): Promise<boolean>;
}

/** One bounded, sanitized audit row. It never carries a token or a header. */
export interface CompetitorSystemLogRow {
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
 *   allowed      the permit was granted for THIS job, generation, target and
 *                bound viewer.
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

/**
 * The outcome of one viewer attachment.
 *
 * The attachment is the JOB-SCOPED admission decision: it proves that the
 * target is admitted and that THIS viewer is the one the policy approves
 * for it. Its refusals are distinct, because they lead to distinct
 * outcomes:
 *
 *   not_approved             the policy does not approve this viewer for
 *                            this target. The candidate is EXCLUDED from
 *                            the eligible set and the next candidate is
 *                            offered. It is a filter step, not a refusal
 *                            of the work.
 *   already_bound            this generation already carries another
 *                            viewer. The candidate is excluded for the same
 *                            reason.
 *   target_not_eligible      the TARGET is not admitted. The work is
 *                            refused and nothing is written.
 *   configuration_unavailable the rollout configuration cannot be read, or
 *                            the collection is disabled. The work is refused
 *                            and the run stops: the outcome is unknown.
 *   viewer_unusable          the viewer cannot perform a Business Discovery:
 *                            it is inactive, it needs a reconnect, it has
 *                            no readable capability, it is not page-linked
 *                            or it holds no insights scope.
 *   stale_claim              the lease or the generation moved on.
 *   unavailable              the call could not be read at all.
 *
 * Every refusal that ends the work carries `auditStored`: the accepted SQL
 * refuses by RAISING, so its own audit row did not commit, and this module
 * wrote it in a separate bounded call.
 */
export type ViewerAttachDecision =
  | { readonly kind: "attached"; readonly context: AttachedViewerContext }
  | { readonly kind: "not_approved" }
  | { readonly kind: "already_bound" }
  | { readonly kind: "target_not_eligible"; readonly auditStored: boolean }
  | { readonly kind: "configuration_unavailable"; readonly auditStored: boolean }
  | { readonly kind: "viewer_unusable"; readonly auditStored: boolean }
  | { readonly kind: "stale_claim"; readonly auditStored: boolean }
  | {
    readonly kind: "unavailable";
    readonly reasonCode: string;
    readonly auditStored: boolean;
  };

/** The tables this feature reads with the service role. */
export type ServiceOwnedTable =
  | "social_accounts"
  | "instagram_account_capabilities"
  | "competitor_watchlist"
  | "instagram_provider_throttle_buckets";

/**
 * The narrow read surface of the service client.
 *
 * The table name is a closed union, so a dynamic table name cannot be
 * smuggled in, and the filters are the owner-scoped ones this feature
 * needs.
 */
export interface ServiceReadPort {
  readOne(
    table: ServiceOwnedTable,
    columns: string,
    filters: Record<string, unknown>,
  ): Promise<unknown>;
  readMany(
    table: ServiceOwnedTable,
    columns: string,
    filters: Record<string, unknown>,
    limit: number,
  ): Promise<unknown>;
}

/** The RPC caller. The owner and the service paths differ in the client. */
export type CompetitorRpcCaller = (
  functionName: string,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** The stable failure kinds of the store. */
export type CompetitorStoreFailure =
  | "forbidden"
  | "not_found"
  | "stale_claim"
  | "invalid"
  | "schema_unavailable"
  | "read_failed"
  | "write_failed";

export class CompetitorStoreError extends Error {
  readonly failure: CompetitorStoreFailure;
  readonly sqlstate: string | null;

  constructor(failure: CompetitorStoreFailure, sqlstate: string | null = null) {
    super("The competitor collection store could not complete the operation.");
    this.name = "CompetitorStoreError";
    this.failure = failure;
    this.sqlstate = sqlstate;
  }
}

// ---------------------------------------------------------------------------
// The strict envelope helpers
// ---------------------------------------------------------------------------

/**
 * Maps a driver error onto a stable failure kind.
 *
 * Only the SQLSTATE is read. The message is never copied.
 */
function classifyDriverError(error: unknown): CompetitorStoreError {
  if (!isPlainRecord(error)) {
    return new CompetitorStoreError("read_failed");
  }

  const code = readOwnData(error, "code");
  const sqlstate = code.present && typeof code.value === "string" ? code.value : null;

  if (sqlstate === "42501") return new CompetitorStoreError("forbidden", sqlstate);
  if (sqlstate === "P0002") return new CompetitorStoreError("not_found", sqlstate);
  if (sqlstate === "40001") return new CompetitorStoreError("stale_claim", sqlstate);
  if (sqlstate === "22023" || sqlstate === "23514" || sqlstate === "23505") {
    return new CompetitorStoreError("invalid", sqlstate);
  }
  if (sqlstate === "PGRST202" || sqlstate === "42883") {
    return new CompetitorStoreError("schema_unavailable", sqlstate);
  }
  if (sqlstate === "PGRST116") return new CompetitorStoreError("not_found", sqlstate);

  return new CompetitorStoreError("read_failed", sqlstate);
}

/**
 * Reads the payload of a completed call.
 *
 * A missing `error` property is a malformed envelope and is a failure: it
 * is never read as a completed read.
 */
function readCompletedData(envelope: unknown): unknown {
  if (!isPlainRecord(envelope)) {
    throw new CompetitorStoreError("read_failed");
  }

  // Both own data descriptors are validated BEFORE any SQLSTATE is trusted:
  // an envelope with a missing or accessor `data` is malformed, and a
  // malformed envelope is indeterminate even when its `error` looks
  // definitive. Getters are never invoked.
  const error = readOwnData(envelope, "error");
  const data = readOwnData(envelope, "data");
  if (!error.present || !data.present) {
    throw new CompetitorStoreError("read_failed");
  }
  if (error.value !== null) {
    throw classifyDriverError(error.value);
  }

  return data.value;
}

async function callRpc(
  rpc: CompetitorRpcCaller,
  functionName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  let envelope: unknown;
  try {
    envelope = await rpc(functionName, args);
  } catch (error) {
    if (error instanceof CompetitorStoreError) throw error;
    throw new CompetitorStoreError("read_failed");
  }
  return readCompletedData(envelope);
}

function requireString(record: Record<string, unknown>, key: string): string {
  const value = readOwnData(record, key);
  if (!value.present || typeof value.value !== "string" || value.value.length === 0) {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value;
}

function optionalString(record: Record<string, unknown>, key: string): string | null {
  const value = readOwnData(record, key);
  if (!value.present || value.value === null || value.value === undefined) return null;
  if (typeof value.value !== "string") {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value;
}

function requireNumber(record: Record<string, unknown>, key: string): number {
  const value = readOwnData(record, key);
  if (!value.present || typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value;
}

function optionalNumber(record: Record<string, unknown>, key: string): number | null {
  const value = readOwnData(record, key);
  if (!value.present || value.value === null || value.value === undefined) return null;
  if (typeof value.value !== "number" || !Number.isFinite(value.value)) {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value;
}

function requireObject(value: unknown): Record<string, unknown> {
  if (!isPlainRecord(value)) {
    throw new CompetitorStoreError("read_failed");
  }
  return value;
}

function requireArray(value: unknown): unknown[] {
  if (!Array.isArray(value)) {
    throw new CompetitorStoreError("read_failed");
  }
  return value;
}

// ---------------------------------------------------------------------------
// The owner path
// ---------------------------------------------------------------------------

/**
 * The owner-facing store.
 *
 * It runs the statements as the verified caller, so PostgreSQL derives the
 * owner from `auth.uid()` and the accepted structural ownership check is
 * the authority.
 */
export interface CompetitorOwnerStore {
  enqueueCompetitorJob(input: {
    readonly watchlistId: string;
    readonly mode: "normal" | "force";
    readonly signal?: AbortSignal;
  }): Promise<CompetitorEnqueueOutcome>;
  readCompetitorStatus(input: {
    readonly watchlistId: string;
    readonly capturedOn: string | null;
    readonly signal?: AbortSignal;
  }): Promise<OwnerStatusProjection>;
}

export function createCompetitorOwnerStore(rpc: CompetitorRpcCaller): CompetitorOwnerStore {
  return {
    async enqueueCompetitorJob(input) {
      const data = await callRpc(rpc, "enqueue_instagram_collection_job", {
        p_target_kind: "competitor",
        p_target_id: input.watchlistId,
        p_mode: input.mode,
      });

      // A DEFINITE rollout refusal. The database resolved the owner and the
      // target and then refused the target, so nothing was inserted and no
      // throttle window was spent. It is a distinct outcome and it is never
      // read as an accepted enqueue.
      const refused = parseEnqueueRefusal(data);
      if (refused !== null) return { kind: "refused", projection: refused };

      // A receipt that is not exactly an accepted projection is indeterminate:
      // the enqueue may or may not have happened, and it is never replaced by
      // a guess.
      const receipt = parseEnqueueReceipt(data, input.mode);
      if (receipt === null) throw new CompetitorStoreError("read_failed");
      return receipt.accepted
        ? { kind: "accepted", projection: receipt }
        : { kind: "throttled", projection: receipt };
    },

    async readCompetitorStatus(input) {
      const data = await callRpc(rpc, "read_instagram_collection_job_status", {
        p_target_kind: "competitor",
        p_target_id: input.watchlistId,
        p_capture_day: input.capturedOn,
      });

      // A failed or malformed read is never "no job".
      const status = parseOwnerStatus(data, input.watchlistId, input.capturedOn);
      if (status === null) throw new CompetitorStoreError("read_failed");
      return status;
    },
  };
}

// ---------------------------------------------------------------------------
// The service path
// ---------------------------------------------------------------------------

/** The service-facing store. Every call carries a service credential. */
export interface CompetitorServiceStore {
  listDueTargets(input: {
    readonly limit: number;
    readonly cursor: DueTargetCursor | null;
    readonly signal?: AbortSignal;
  }): Promise<DueCompetitorTarget[]>;
  enqueueService(input: {
    readonly ownerId: string;
    readonly watchlistIds: readonly string[];
    readonly signal?: AbortSignal;
  }): Promise<{ readonly accepted: number; readonly results: readonly unknown[] }>;
  claimCompetitorJobs(input: {
    readonly limit: number;
    readonly signal?: AbortSignal;
  }): Promise<ClaimedCompetitorJob[]>;
  readWatchlistTarget(input: {
    readonly watchlistId: string;
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): Promise<{ readonly userId: string; readonly username: string } | null>;
  listViewerCandidates(input: {
    readonly userId: string;
    readonly signal?: AbortSignal;
  }): Promise<ViewerCandidate[]>;
  resolveViewerCredential(input: {
    readonly userId: string;
    readonly socialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<ResolvedViewerCredential>;
  attachViewerContext(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly viewerSocialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<ViewerAttachDecision>;
  /**
   * The per-request admission permit.
   *
   * The database derives every identity from the LIVE fenced job, so this
   * call names the job, its claim token and its generation and NOTHING
   * else: it can never redirect the request to another owner, another
   * target or another viewer.
   *
   * The answer is a typed decision. A refusal is a refusal, a permit that
   * could not be read is UNAVAILABLE, and neither is ever permission.
   */
  authorizeProviderCall(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly targetId: string;
    readonly viewerSocialAccountId: string;
    readonly signal?: AbortSignal;
  }): Promise<ProviderPermitDecision>;
  /**
   * The EXCEPTION-PATH audit of a refusal the accepted SQL could not audit.
   *
   * The viewer attachment refuses by RAISING, so the row the accepted SQL
   * would have written did not commit with the refusal. The caller uses
   * this port for the refusal that ends the WORK - a target the policy
   * does not admit, a configuration that cannot be read - and never for
   * the per-candidate exclusions of the candidate restriction, which are
   * excluded rows and not thousands of refusal events.
   *
   * It answers whether the row COMMITTED. A failed write is false, never a
   * stored row, and the caller stops the work and reports the audit
   * failure.
   */
  auditAdmissionRefusal(input: {
    readonly jobId: string;
    readonly reasonCode: string;
  }): Promise<boolean>;
  persistResult(input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly payload: CompetitorResultPayload;
    readonly signal?: AbortSignal;
  }): Promise<PersistResultReceipt>;
  recordThrottle(input: {
    readonly bucketKey: string;
    readonly usagePercent: number | null;
    readonly throttledUntil: string | null;
    readonly jobId?: string;
    readonly claimToken?: string;
    readonly jobGeneration?: number;
    readonly signal?: AbortSignal;
  }): Promise<void>;
  readThrottleBucket(input: {
    readonly bucketKey: string;
    readonly signal?: AbortSignal;
  }): Promise<ThrottleBucketState | null>;
}

export interface CompetitorServiceStoreDeps {
  readonly rpc: CompetitorRpcCaller;
  readonly reads: ServiceReadPort;
  /**
   * The narrow write surface. It is used for the EXCEPTION-PATH audit only:
   * a refusal the accepted SQL could not audit itself, because the
   * statement raised and the raise rolled its audit row back.
   */
  readonly writes: CompetitorServiceWritePort;
}

/**
 * The non-secret placeholder that satisfies the shared selector's
 * non-empty token check.
 *
 * It is not a credential, it grants nothing and it is never sent to a
 * provider. The real credential is resolved through the protected
 * credential adapter.
 */
export const SELECTOR_TOKEN_SENTINEL = "protected-credential-not-a-token";

/** The insights scopes a viewer may hold. */
const INSIGHTS_SCOPES = ["instagram_manage_insights", "instagram_business_manage_insights"];

/**
 * The refusal markers of the accepted SQL.
 *
 * The viewer attachment refuses by RAISING, and every one of its refusals
 * carries the same SQLSTATE, so the SQLSTATE alone cannot tell a policy
 * refusal from an unusable viewer. The marker at the start of the message is
 * the only thing that distinguishes them, so it is matched against this
 * CLOSED list and the message itself is never copied into a decision, a
 * log, an error or a response.
 */
const ATTACH_REFUSAL_MARKERS = [
  "IG_COLLECTION_VIEWER_NOT_APPROVED",
  "IG_COLLECTION_VIEWER_ALREADY_BOUND",
  "IG_COLLECTION_NOT_ELIGIBLE",
  "IG_COLLECTION_DISABLED",
  "IG_COLLECTION_SETTINGS_UNAVAILABLE",
  "IG_COLLECTION_CLAIM_STALE",
  "IG_COLLECTION_CREDENTIAL_CHANGED",
  "IG_COLLECTION_VIEWER_NOT_OWNED",
  "IG_COLLECTION_VIEWER_INACTIVE",
  "IG_COLLECTION_VIEWER_NEEDS_REAUTH",
  "IG_COLLECTION_VIEWER_CAPABILITY_MISSING",
  "IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN",
  "IG_COLLECTION_VIEWER_SCOPE_MISSING",
  "IG_COLLECTION_TARGET_INACTIVE",
  "IG_COLLECTION_JOB_NOT_FOUND",
] as const;

/**
 * The refusal of one attachment, before it is turned into a decision.
 *
 * The two filter kinds are separate from the rest, because they exclude a
 * CANDIDATE while the rest refuse the WORK.
 */
type AttachOutcome =
  | { readonly kind: "attached"; readonly context: AttachedViewerContext }
  | { readonly kind: "not_approved" }
  | { readonly kind: "already_bound" }
  | {
    readonly kind: "target_not_eligible" | "configuration_unavailable" |
      "viewer_unusable" | "stale_claim";
    readonly reasonCode: string;
  }
  | { readonly kind: "unavailable"; readonly reasonCode: string };

/**
 * Reads the marker of a raised refusal.
 *
 * Only a marker of the closed list is returned, and only its NAME. The
 * message never leaves this function.
 */
function readRefusalMarker(error: unknown): string | null {
  if (!isPlainRecord(error)) return null;
  const message = readOwnData(error, "message").value;
  if (typeof message !== "string") return null;
  for (const marker of ATTACH_REFUSAL_MARKERS) {
    if (message.includes(`${marker}:`)) return marker;
  }
  return null;
}

/**
 * Asks the database to attach the viewer and reads its answer.
 *
 * The call names the job, its claim, its generation and the ONE viewer it
 * is about to bind. It never names an owner, and it never names a
 * substitute: the database decides whether this viewer is the approved
 * one.
 */
async function readAttachOutcome(
  rpc: CompetitorRpcCaller,
  input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
    readonly viewerSocialAccountId: string;
  },
): Promise<AttachOutcome> {
  let envelope: unknown;
  try {
    envelope = await rpc("attach_instagram_collection_job_viewer_context", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_job_generation: input.jobGeneration,
      p_viewer_social_account_id: input.viewerSocialAccountId,
    });
  } catch {
    // A thrown transport failure never reached the accepted SQL, so the
    // statement may or may not have run. It is a failure, never an approval.
    return { kind: "unavailable", reasonCode: "attach_read_failed" };
  }

  if (!isPlainRecord(envelope)) {
    return { kind: "unavailable", reasonCode: "malformed_envelope" };
  }

  const error = readOwnData(envelope, "error");
  const data = readOwnData(envelope, "data");
  if (!error.present || !data.present) {
    return { kind: "unavailable", reasonCode: "malformed_envelope" };
  }

  if (error.value !== null) {
    const marker = readRefusalMarker(error.value);
    switch (marker) {
      case "IG_COLLECTION_VIEWER_NOT_APPROVED":
        return { kind: "not_approved" };
      case "IG_COLLECTION_VIEWER_ALREADY_BOUND":
        return { kind: "already_bound" };
      case "IG_COLLECTION_NOT_ELIGIBLE":
      case "IG_COLLECTION_TARGET_INACTIVE":
        return { kind: "target_not_eligible", reasonCode: marker };
      case "IG_COLLECTION_DISABLED":
      case "IG_COLLECTION_SETTINGS_UNAVAILABLE":
        return { kind: "configuration_unavailable", reasonCode: marker };
      case "IG_COLLECTION_CLAIM_STALE":
      case "IG_COLLECTION_CREDENTIAL_CHANGED":
      case "IG_COLLECTION_JOB_NOT_FOUND":
        return { kind: "stale_claim", reasonCode: marker };
      case "IG_COLLECTION_VIEWER_NOT_OWNED":
      case "IG_COLLECTION_VIEWER_INACTIVE":
      case "IG_COLLECTION_VIEWER_NEEDS_REAUTH":
      case "IG_COLLECTION_VIEWER_CAPABILITY_MISSING":
      case "IG_COLLECTION_VIEWER_UNSUPPORTED_LOGIN":
      case "IG_COLLECTION_VIEWER_SCOPE_MISSING":
        return { kind: "viewer_unusable", reasonCode: marker };
      default:
        // An unknown refusal is UNAVAILABLE, never an approval and never a
        // filter step.
        return { kind: "unavailable", reasonCode: "attach_refused" };
    }
  }

  if (!isPlainRecord(data.value)) {
    return { kind: "unavailable", reasonCode: "malformed_envelope" };
  }

  const row = data.value;
  const viewerSocialAccountId = readOwnData(row, "viewer_social_account_id").value;
  const credentialGeneration = readOwnData(row, "credential_generation").value;
  const loginKind = readOwnData(row, "login_kind").value;
  if (
    typeof viewerSocialAccountId !== "string" ||
    typeof credentialGeneration !== "number" ||
    !Number.isFinite(credentialGeneration) ||
    typeof loginKind !== "string"
  ) {
    return { kind: "unavailable", reasonCode: "malformed_envelope" };
  }

  return {
    kind: "attached",
    context: {
      viewerSocialAccountId,
      credentialGeneration,
      loginKind,
    },
  };
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
  rpc: CompetitorRpcCaller,
  input: {
    readonly jobId: string;
    readonly claimToken: string;
    readonly jobGeneration: number;
  },
): Promise<PermitEnvelope> {
  let envelope: unknown;
  try {
    envelope = await rpc("authorize_instagram_collection_provider_call", {
      p_job_id: input.jobId,
      p_claim_token: input.claimToken,
      p_job_generation: input.jobGeneration,
    });
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
 * a refusal that RAISED, or a permit that could not be read at all. It is
 * bounded and sanitized - an event, a reason code and the job id - and it
 * never carries a token, a claim token, a policy list or provider text.
 *
 * It answers whether the row COMMITTED. A failed write is never reported as
 * a stored row.
 */
async function auditRefusal(
  writes: CompetitorServiceWritePort,
  event: {
    readonly event: string;
    readonly reasonCode: string;
    readonly jobId: string;
    readonly action: string;
  },
): Promise<boolean> {
  try {
    return await writes.insertSystemLog({
      source: "instagram-collection-rollout",
      category: "database",
      level: "warn",
      message: "Instagram collection rollout refusal",
      userId: null,
      metadata: {
        event: event.event,
        reason_code: event.reasonCode,
        job_id: event.jobId,
        action: event.action,
      },
    });
  } catch {
    return false;
  }
}

export function createCompetitorServiceStore(
  deps: CompetitorServiceStoreDeps,
): CompetitorServiceStore {
  const credentialStore = createFacebookUserCredentialStore(deps.rpc);
  const capabilityStore = createInstagramAccountCapabilityStore(deps.rpc);

  return {
    async listDueTargets(input) {
      const data = await callRpc(deps.rpc, "list_due_competitor_collection_targets", {
        p_limit: input.limit,
        p_after_due_at: input.cursor?.dueAt ?? null,
        p_after_id: input.cursor?.id ?? null,
      });

      const rows = requireArray(data);
      return rows.map((entry) => {
        const row = requireObject(entry);
        return {
          userId: requireString(row, "user_id"),
          watchlistId: requireString(row, "watchlist_id"),
          username: requireString(row, "username"),
          dueAt: requireString(row, "due_at"),
        };
      });
    },

    async enqueueService(input) {
      const requests = input.watchlistIds.map((watchlistId) => ({
        target_kind: "competitor",
        target_id: watchlistId,
        mode: "normal",
      }));

      const data = await callRpc(deps.rpc, "enqueue_instagram_collection_jobs_service", {
        p_owner_id: input.ownerId,
        p_requests: requests,
      });

      const row = requireObject(data);
      const results = requireArray(readOwnData(row, "results").value);
      const accepted = optionalNumber(row, "accepted") ?? 0;
      if (!Number.isSafeInteger(accepted) || accepted < 0 || accepted > requests.length) {
        throw new CompetitorStoreError("read_failed");
      }
      return { accepted, results };
    },

    async claimCompetitorJobs(input) {
      const data = await callRpc(deps.rpc, "claim_instagram_collection_jobs", {
        p_target_kind: "competitor",
        p_limit: input.limit,
      });

      const rows = requireArray(data);
      return rows.map((entry) => {
        const row = requireObject(entry);
        const watchlistId = optionalString(row, "watchlist_id");
        if (watchlistId === null) {
          throw new CompetitorStoreError("read_failed");
        }
        return {
          jobId: requireString(row, "job_id"),
          userId: requireString(row, "user_id"),
          watchlistId,
          capturedOn: requireString(row, "captured_on"),
          jobGeneration: requireNumber(row, "job_generation"),
          claimToken: requireString(row, "claim_token"),
          leaseExpiresAt: requireString(row, "lease_expires_at"),
          attempts: requireNumber(row, "attempts"),
        };
      });
    },

    async readWatchlistTarget(input) {
      const envelope = await deps.reads.readOne(
        "competitor_watchlist",
        "id, user_id, username, is_active",
        { id: input.watchlistId, user_id: input.userId },
      );

      const row = readCompletedData(envelope);
      if (row === null || row === undefined) return null;

      const record = requireObject(row);
      const userId = requireString(record, "user_id");
      if (userId !== input.userId) {
        // The read was owner-scoped, so a different owner is not readable.
        // A row that names another owner is a contract violation, not a
        // miss.
        throw new CompetitorStoreError("read_failed");
      }

      return {
        userId,
        username: requireString(record, "username"),
      };
    },

    async listViewerCandidates(input) {
      const accountsEnvelope = await deps.reads.readMany(
        "social_accounts",
        "id, user_id, platform, platform_user_id, is_active, needs_reauth, connected_at",
        { user_id: input.userId, platform: "instagram" },
        200,
      );
      const accounts = requireArray(readCompletedData(accountsEnvelope));

      const capabilitiesEnvelope = await deps.reads.readMany(
        "instagram_account_capabilities",
        "social_account_id, user_id, platform, login_kind, permission_read_state, " +
        "granted_scopes, credential_generation",
        { user_id: input.userId, platform: "instagram" },
        200,
      );
      const capabilities = requireArray(readCompletedData(capabilitiesEnvelope));

      const capabilityByAccount = new Map<string, Record<string, unknown>>();
      for (const entry of capabilities) {
        const row = requireObject(entry);
        const accountId = requireString(row, "social_account_id");
        capabilityByAccount.set(accountId, row);
      }

      const candidates: ViewerCandidate[] = [];

      for (const entry of accounts) {
        const row = requireObject(entry);
        const accountId = requireString(row, "id");
        const capability = capabilityByAccount.get(accountId);
        if (!capability) continue;

        // The TRUSTED login kind. A client-editable metadata hint is not
        // authority and is not read at all.
        const loginKind = optionalString(capability, "login_kind");
        if (loginKind !== "page_linked") continue;

        // Only a successful permission read is authoritative. An unknown or
        // failed read is not a grant and not a denial.
        const readState = optionalString(capability, "permission_read_state");
        if (readState !== "ok") continue;

        const scopes = readStringArray(capability, "granted_scopes");
        if (!scopes.some((scope) => INSIGHTS_SCOPES.includes(scope))) continue;

        const isActive = optionalBoolean(row, "is_active");
        if (isActive !== true) continue;
        if (optionalBoolean(row, "needs_reauth") === true) continue;

        const platformUserId = optionalString(row, "platform_user_id");
        if (platformUserId === null || platformUserId === "") continue;

        const userId = requireString(row, "user_id");
        if (userId !== input.userId) continue;

        candidates.push({
          id: accountId,
          user_id: userId,
          platform: "instagram",
          platform_user_id: platformUserId,
          // The sentinel is not a credential. The shared selector refuses a
          // candidate without one; the real credential never passes
          // through this projection.
          access_token: SELECTOR_TOKEN_SENTINEL,
          is_active: true,
          needs_reauth: false,
          ig_auth_type: null,
          // The trusted metadata is CONSTRUCTED HERE, from the protected
          // capability row. It is never the stored account metadata.
          account_metadata: { granted_scopes: scopes },
          connected_at: optionalString(row, "connected_at"),
        });
      }

      return candidates;
    },

    async resolveViewerCredential(input) {
      // The credential read and the capability read are the two accepted
      // adapters over the protected authority. The rules applied here are
      // the same ones `_shared/protectedFacebookCredentials.ts` applies:
      // an owned account, the Facebook User credential kind, a present
      // token, and - for Instagram - a page-linked login kind. A direct
      // Instagram login cannot perform a Business Discovery, and the Page
      // token is never a substitute.
      //
      // The credential read is the authority for BOTH the token and the
      // generation. The capability row is read separately for the trusted
      // login kind, and the two generations are compared: a reconnect
      // between the two reads shows up as a mismatch and is refused. A
      // capability read on its own could be newer than the token, and a
      // reconnect between the two would then slip through.
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
        throw new CompetitorStoreError("not_found");
      }
      if (binding.credentialKind !== "facebook_user" || !binding.token ||
        !binding.credentialId || binding.revision === null) {
        throw new CompetitorStoreError("read_failed");
      }
      if (binding.platform !== "instagram") {
        throw new CompetitorStoreError("read_failed");
      }

      const generation = binding.capabilityGeneration;
      if (generation === null || !Number.isFinite(generation)) {
        throw new CompetitorStoreError("read_failed");
      }

      let capability;
      try {
        capability = await capabilityStore.readCapability({
          userId: input.userId,
          socialAccountId: input.socialAccountId,
        });
      } catch (error) {
        throw mapCredentialError(error);
      }

      if (capability.loginKind !== "page_linked") {
        throw new CompetitorStoreError("read_failed");
      }
      if (capability.credentialGeneration !== generation) {
        // The credential was replaced between the two reads. The caller
        // must not spend a provider call on a token whose generation no
        // longer matches the connection.
        throw new CompetitorStoreError("stale_claim");
      }

      return {
        token: binding.token,
        credentialId: binding.credentialId,
        capabilityGeneration: generation,
      };
    },

    async attachViewerContext(input) {
      // The attachment is the JOB-SCOPED admission decision. It refuses by
      // raising, so its refusal is read from the marker the accepted SQL
      // puts at the start of its own message - never from provider text and
      // never from anything the caller supplied.
      const outcome = await readAttachOutcome(deps.rpc, input);

      if (outcome.kind === "attached") return outcome;

      if (outcome.kind === "not_approved" || outcome.kind === "already_bound") {
        // A filter step of the candidate restriction, not a refusal of the
        // work. The candidate is excluded and the next one is offered.
        return outcome;
      }

      // Every other refusal ends the work, and the accepted SQL's own audit
      // row did not commit with it: the raise rolled it back. The row is
      // written here, in a separate bounded call.
      const auditStored = await auditRefusal(deps.writes, {
        event: "collection_viewer_attach_refused",
        reasonCode: outcome.reasonCode,
        jobId: input.jobId,
        action: "attach_viewer_context",
      });

      switch (outcome.kind) {
        case "target_not_eligible":
          return { kind: "target_not_eligible", auditStored };
        case "configuration_unavailable":
          return { kind: "configuration_unavailable", auditStored };
        case "viewer_unusable":
          return { kind: "viewer_unusable", auditStored };
        case "stale_claim":
          return { kind: "stale_claim", auditStored };
        default:
          return {
            kind: "unavailable",
            reasonCode: outcome.reasonCode,
            auditStored,
          };
      }
    },

    async authorizeProviderCall(input) {
      const envelope = await readPermitEnvelope(deps.rpc, input);

      if (envelope.kind === "unreadable") {
        // The permit could not be read. The accepted SQL never saw this
        // call, so IT could not audit it either: the row is written here, in
        // a separate bounded call, and the answer says whether it committed.
        const auditStored = await auditRefusal(deps.writes, {
          event: "collection_provider_call_refused",
          reasonCode: envelope.reasonCode,
          jobId: input.jobId,
          action: "authorize_provider_call",
        });
        return {
          kind: "unavailable",
          reasonCode: envelope.reasonCode,
          auditStored,
        };
      }

      const permit = parseProviderPermit(envelope.data, {
        jobId: input.jobId,
        jobGeneration: input.jobGeneration,
        targetId: input.targetId,
        viewerSocialAccountId: input.viewerSocialAccountId,
      });

      if (permit === null) {
        // The answer is not the projection this contract knows. It is
        // unavailable, never permission, and the refusal is audited here.
        const auditStored = await auditRefusal(deps.writes, {
          event: "collection_provider_call_refused",
          reasonCode: "malformed_envelope",
          jobId: input.jobId,
          action: "authorize_provider_call",
        });
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

    async auditAdmissionRefusal(input) {
      return await auditRefusal(deps.writes, {
        event: "collection_admission_refused",
        reasonCode: input.reasonCode,
        jobId: input.jobId,
        action: "resolve_eligible_viewer",
      });
    },

    async persistResult(input) {
      // The v2 writer. It is the versioned one: the same four arguments as
      // v1, plus the coverage evidence in the payload, and a receipt that
      // carries `version = 2`. The v1 writer stays callable in the database
      // for deployment compatibility; nothing here calls it.
      const data = await callRpc(deps.rpc, "persist_competitor_collection_result_v2", {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_job_generation: input.jobGeneration,
        p_payload: input.payload,
      });

      // The receipt must answer for THIS job, generation, outcome and
      // capture, and it must report the coverage the database STORED. One
      // that disagrees is not evidence the write happened as asked, so it is
      // indeterminate, never success.
      const receipt = parseCoverageResultReceipt(data, input);
      if (receipt === null) throw new CompetitorStoreError("read_failed");
      return receipt;
    },

    async recordThrottle(input) {
      const data = await callRpc(deps.rpc, "record_instagram_provider_throttle", {
        p_bucket_key: input.bucketKey,
        p_usage_percent: input.usagePercent,
        p_throttled_until: input.throttledUntil,
        p_job_id: input.jobId ?? null,
        p_claim_token: input.claimToken ?? null,
        p_job_generation: input.jobGeneration ?? null,
      });

      // A null or partial receipt is not proof the shared backoff was stored.
      if (!isThrottleReceipt(data, { bucketKey: input.bucketKey, jobId: input.jobId ?? null })) {
        throw new CompetitorStoreError("read_failed");
      }
    },

    async readThrottleBucket(input) {
      const envelope = await deps.reads.readOne(
        "instagram_provider_throttle_buckets",
        "bucket_key, usage_percent, throttled_until",
        { bucket_key: input.bucketKey },
      );

      const row = readCompletedData(envelope);
      if (row === null || row === undefined) return null;

      const record = requireObject(row);
      return {
        usagePercent: optionalNumber(record, "usage_percent"),
        throttledUntil: optionalString(record, "throttled_until"),
      };
    },
  };
}

function readStringArray(record: Record<string, unknown>, key: string): string[] {
  const value = readOwnData(record, key);
  if (!value.present) return [];
  if (!Array.isArray(value.value)) {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value.map((entry) => {
    if (typeof entry !== "string") {
      throw new CompetitorStoreError("read_failed");
    }
    return entry;
  });
}

function optionalBoolean(record: Record<string, unknown>, key: string): boolean | null {
  const value = readOwnData(record, key);
  if (!value.present || value.value === null || value.value === undefined) return null;
  if (typeof value.value !== "boolean") {
    throw new CompetitorStoreError("read_failed");
  }
  return value.value;
}

/**
 * Maps a protected-credential refusal onto a store failure.
 *
 * The credential adapter already classifies the driver error; its message
 * is never copied.
 */
function mapCredentialError(error: unknown): CompetitorStoreError {
  if (error instanceof CredentialStoreError) {
    if (error.code === "not_found") return new CompetitorStoreError("not_found", error.sqlstate);
    if (error.code === "refused") return new CompetitorStoreError("forbidden", error.sqlstate);
    if (error.code === "schema_unavailable") {
      return new CompetitorStoreError("schema_unavailable", error.sqlstate);
    }
    if (error.code === "stale_version") return new CompetitorStoreError("stale_claim", error.sqlstate);
    return new CompetitorStoreError("read_failed", error.sqlstate);
  }
  return new CompetitorStoreError("read_failed");
}
