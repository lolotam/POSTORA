/**
 * Worker Database Store for Instagram Durable Collection Jobs.
 *
 * Implements the service-role database contracts for durable jobs:
 * - claim_instagram_collection_jobs('owner', limit)
 * - persist_instagram_collection_snapshot(job_id, claim_token, job_generation, payload)
 * - complete_instagram_collection_job(job_id, claim_token, job_generation, outcome, reason_code)
 * - record_instagram_provider_throttle(bucket_name, retry_after)
 *
 * Enforces strict descriptor checks, descriptor validation, and safe error classification.
 */

export interface ClaimedJobContext {
  viewerSocialAccountId?: string;
  credentialGeneration?: number;
  loginKind?: "direct" | "page_linked";
  capabilityPresent?: boolean;
  permissionReadState?: string;
  grantedScopes?: string[];
}

export interface ClaimedJob {
  jobId: string;
  userId: string;
  targetId: string;
  socialAccountId: string;
  capturedOn: string;
  jobGeneration: number;
  claimToken: string;
  leaseExpiresAt: string;
  attempts: number;
  context: ClaimedJobContext;
  checkpoint: Record<string, unknown>;
  pendingOperations: unknown[];
  claimedAt: string;
}

export type JobOutcome = "completed" | "partial" | "retry" | "unavailable" | "error";

export type ServiceRpcCaller = (
  name: string,
  args: Record<string, unknown>
) => Promise<unknown>;

export class WorkerStoreError extends Error {
  readonly code: string;
  constructor(message: string, code: string) {
    super(message);
    this.name = "WorkerStoreError";
    this.code = code;
  }
}

function assertOwnDataProperty(obj: unknown, prop: string): unknown {
  if (!obj || typeof obj !== "object") {
    throw new WorkerStoreError(`Expected object, got ${typeof obj}`, "invalid_envelope");
  }
  const desc = Object.getOwnPropertyDescriptor(obj, prop);
  if (!desc) {
    throw new WorkerStoreError(`Missing required property: ${prop}`, "missing_property");
  }
  if ("get" in desc || "set" in desc) {
    throw new WorkerStoreError(`Accessor property forbidden: ${prop}`, "accessor_forbidden");
  }
  return desc.value;
}

function parseClaimedJob(raw: unknown): ClaimedJob {
  const job = raw as Record<string, unknown>;
  const jobId = String(assertOwnDataProperty(job, "job_id"));
  const userId = String(assertOwnDataProperty(job, "user_id"));
  const targetId = String(assertOwnDataProperty(job, "target_id"));
  const socialAccountId = String(assertOwnDataProperty(job, "social_account_id"));
  const capturedOn = String(assertOwnDataProperty(job, "captured_on"));
  const jobGeneration = Number(assertOwnDataProperty(job, "job_generation"));
  const claimToken = String(assertOwnDataProperty(job, "claim_token"));
  const leaseExpiresAt = String(assertOwnDataProperty(job, "lease_expires_at"));
  const attempts = Number(assertOwnDataProperty(job, "attempts"));
  const rawCtx = (assertOwnDataProperty(job, "context") ?? {}) as Record<string, unknown>;

  const context: ClaimedJobContext = {
    viewerSocialAccountId: rawCtx.viewer_social_account_id ? String(rawCtx.viewer_social_account_id) : undefined,
    credentialGeneration: typeof rawCtx.credential_generation === "number" ? rawCtx.credential_generation : undefined,
    loginKind: rawCtx.login_kind === "direct" || rawCtx.login_kind === "page_linked" ? rawCtx.login_kind : undefined,
    capabilityPresent: Boolean(rawCtx.capability_present),
    permissionReadState: rawCtx.permission_read_state ? String(rawCtx.permission_read_state) : undefined,
    grantedScopes: Array.isArray(rawCtx.granted_scopes) ? rawCtx.granted_scopes.map(String) : [],
  };

  const checkpoint = (job.checkpoint && typeof job.checkpoint === "object" ? job.checkpoint : {}) as Record<
    string,
    unknown
  >;
  const pendingOperations = Array.isArray(job.pending_operations) ? job.pending_operations : [];
  const claimedAt = String(job.claimed_at ?? new Date().toISOString());

  return {
    jobId,
    userId,
    targetId,
    socialAccountId,
    capturedOn,
    jobGeneration,
    claimToken,
    leaseExpiresAt,
    attempts,
    context,
    checkpoint,
    pendingOperations,
    claimedAt,
  };
}

export class WorkerStore {
  private readonly rpc: ServiceRpcCaller;

  constructor(rpcCaller: ServiceRpcCaller) {
    this.rpc = rpcCaller;
  }

  async claimOwnerJobs(limit = 25): Promise<ClaimedJob[]> {
    const raw = await this.rpc("claim_instagram_collection_jobs", {
      p_target_kind: "owner",
      p_limit: limit,
    });

    const envelope = raw as { data?: unknown; error?: { code?: string; message?: string } };
    if (envelope?.error) {
      throw new WorkerStoreError(envelope.error.message ?? "RPC claim failed", envelope.error.code ?? "claim_failed");
    }

    const items = envelope?.data;
    if (!Array.isArray(items)) {
      return [];
    }

    return items.map(parseClaimedJob);
  }

  async persistSnapshot(
    jobId: string,
    claimToken: string,
    jobGeneration: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    const raw = await this.rpc("persist_instagram_collection_snapshot", {
      p_job_id: jobId,
      p_claim_token: claimToken,
      p_job_generation: jobGeneration,
      p_payload: payload,
    });

    const envelope = raw as { data?: unknown; error?: { code?: string; message?: string } };
    if (envelope?.error) {
      throw new WorkerStoreError(
        envelope.error.message ?? "Snapshot persistence failed",
        envelope.error.code ?? "snapshot_failed"
      );
    }
  }

  async recordProgress(
    jobId: string,
    claimToken: string,
    jobGeneration: number,
    payload: Record<string, unknown>
  ): Promise<void> {
    const raw = await this.rpc("record_instagram_collection_job_progress", {
      p_job_id: jobId,
      p_claim_token: claimToken,
      p_job_generation: jobGeneration,
      p_payload: payload,
    });

    const envelope = raw as { data?: unknown; error?: { code?: string; message?: string } };
    if (envelope?.error) {
      throw new WorkerStoreError(
        envelope.error.message ?? "Progress recording failed",
        envelope.error.code ?? "progress_failed"
      );
    }
  }

  async completeJob(
    jobId: string,
    claimToken: string,
    jobGeneration: number,
    outcome: JobOutcome,
    reasonCode?: string
  ): Promise<void> {
    const raw = await this.rpc("complete_instagram_collection_job", {
      p_job_id: jobId,
      p_claim_token: claimToken,
      p_job_generation: jobGeneration,
      p_outcome: outcome,
      p_reason_code: reasonCode ?? null,
    });

    const envelope = raw as { data?: unknown; error?: { code?: string; message?: string } };
    if (envelope?.error) {
      throw new WorkerStoreError(
        envelope.error.message ?? "Job completion failed",
        envelope.error.code ?? "completion_failed"
      );
    }
  }

  async recordThrottle(bucketName: string, retryAfterSeconds: number): Promise<void> {
    const raw = await this.rpc("record_instagram_provider_throttle", {
      p_bucket_name: bucketName,
      p_retry_after: `${Math.max(1, Math.floor(retryAfterSeconds))} seconds`,
    });

    const envelope = raw as { data?: unknown; error?: { code?: string; message?: string } };
    if (envelope?.error) {
      throw new WorkerStoreError(
        envelope.error.message ?? "Throttle recording failed",
        envelope.error.code ?? "throttle_failed"
      );
    }
  }
}
