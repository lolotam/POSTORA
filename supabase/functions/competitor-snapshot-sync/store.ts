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
  parseOwnerStatus,
  parseCoverageResultReceipt,
  readOwnData,
} from "./receipts.ts";

import type {
  AttachedViewerContext,
  ClaimedCompetitorJob,
  CompetitorResultPayload,
  DueCompetitorTarget,
  DueTargetCursor,
  EnqueueReceipt,
  OwnerStatusProjection,
  PersistResultReceipt,
  ResolvedViewerCredential,
  ThrottleBucketState,
} from "./types.ts";

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
  }): Promise<EnqueueReceipt>;
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

      // A receipt that is not exactly an accepted projection is indeterminate:
      // the enqueue may or may not have happened, and it is never replaced by
      // a guess.
      const receipt = parseEnqueueReceipt(data, input.mode);
      if (receipt === null) throw new CompetitorStoreError("read_failed");
      return receipt;
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
  }): Promise<AttachedViewerContext>;
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
      const data = await callRpc(deps.rpc, "attach_instagram_collection_job_viewer_context", {
        p_job_id: input.jobId,
        p_claim_token: input.claimToken,
        p_job_generation: input.jobGeneration,
        p_viewer_social_account_id: input.viewerSocialAccountId,
      });

      const row = requireObject(data);
      return {
        viewerSocialAccountId: requireString(row, "viewer_social_account_id"),
        credentialGeneration: requireNumber(row, "credential_generation"),
        loginKind: requireString(row, "login_kind"),
      };
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
