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
 *   The protected credential adapter is the only authority for a Facebook
 *   User token. The account row's `access_token` is never read here, and a
 *   direct-login Instagram account - which has no protected binding - is
 *   refused instead of falling back to the browser-readable column. The
 *   trusted capability is read on its own, so a direct-login account can be
 *   decided before the credential is even looked for.
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
 * WHY EVERY RECEIPT IS BOUND TO ITS REQUEST
 *
 *   A receipt that names another job, another generation or another item
 *   count is not evidence that the write happened as asked. It is
 *   indeterminate, and the caller abandons the job to its lease rather than
 *   reporting a success.
 */

import {
  createFacebookUserCredentialStore,
  createInstagramAccountCapabilityStore,
  CredentialStoreError,
} from "../_shared/facebookUserCredentialStore.ts";

import {
  isPlainRecord,
  isTimestampText,
  parseClaimedOwnerJob,
  parseCompleteReceipt,
  parseProgressReceipt,
  parseSnapshotReceipt,
  parseThrottleReceipt,
  readOwnData,
  type ClaimedOwnerJob,
  type CompleteReceipt,
  type OwnerJobOutcome,
  type ProgressReceipt,
  type SnapshotReceipt,
} from "./receipts.ts";

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
  if (sqlstate === "40001") return new OwnerWorkerStoreError("stale_claim", sqlstate);
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
}

/**
 * The trusted capability of an owner account.
 *
 * It is the row the accepted SQL reads for the claim, and it is the only
 * authority for the login kind. The worker reads it BEFORE the protected
 * credential, so a direct-login account is decided without a credential
 * read and without a provider call.
 */
export interface OwnerCapability {
  readonly loginKind: "direct" | "page_linked";
  readonly credentialGeneration: number;
}

/**
 * The inventory metadata of one media row, as the database holds it.
 *
 * It is the metadata the accepted snapshot writer cannot receive from the
 * provider again: the publication time is required by every media snapshot,
 * and the product type decides which metrics exist for that media.
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

      return { loginKind: capability.loginKind, credentialGeneration: generation };
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
      };
    },

    async readOwnerMediaInventory(input) {
      if (input.mediaIds.length === 0) return [];

      const envelope = await deps.reads.readMany(
        "ig_media_insight_snapshots",
        "ig_media_id, media_product_type, media_type, published_at, " +
          "like_count_public, comments_count_public, permalink, caption, thumbnail_url",
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
