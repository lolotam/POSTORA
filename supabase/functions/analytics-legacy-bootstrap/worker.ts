import { z } from "https://esm.sh/zod@3.25.76";
import { awaitWithAbort } from "../_shared/abort.ts";
import { metaResponseThrottle } from "../_shared/metaResponseThrottle.ts";
import { MetaPermissionReadFailure, readPageLinkedPermissions } from "../_shared/pageLinkedInstagramPermissions.ts";
import { BootstrapFailure, captureSchema, type BootstrapReason, verifyLegacyAuthority } from "./provider.ts";

export type BootstrapRpc = (name: string, args: Record<string, unknown>, signal: AbortSignal) => PromiseLike<unknown>;
type BootstrapApps = { facebook: { id: string; secret: string }; instagram: { id: string; secret: string } };
export type BootstrapWorkerInput = { rpc: BootstrapRpc; apps: BootstrapApps; fetcher?: typeof fetch; deadline?: number };
const projectionSchema = z.object({ job_id: z.string().uuid().optional(), account_id: z.string().uuid().optional(),
  state: z.enum(["pending", "verifying", "permission_pending", "ready", "needs_reconnect", "permissions_missing", "retry", "blocked"]),
  reason_code: z.enum(["settings_unavailable", "not_authorized", "account_not_found", "verification_pending", "token_invalid",
    "account_identity_invalid", "stored_user_credential_missing", "stale_capture", "reconcile_required", "permission_verification_pending",
    "permission_read_failed", "verified", "permission_missing", "app_mismatch", "identity_mismatch", "provider_error",
    "provider_malformed", "rate_limited", "budget_exhausted", "direct_verification_unsupported", "not_found"]).nullable().optional(), correlation_id: z.string().uuid().optional(),
  next_action: z.enum(["supported_reconnect", "grant_permissions", "support", "none", "wait"]).optional(),
  reconnect_path: z.literal("/profiles").nullable().optional(),
  retry_at: z.string().nullable().optional(), revision: z.number().int().positive().optional(), installed: z.boolean().optional() });
const executorSchema = projectionSchema.extend({ job_id: z.string().uuid(), revision: z.number().int().positive(),
  lease_id: z.string().uuid(), user_id: z.string().uuid(), capture: captureSchema });
type Executor = z.infer<typeof executorSchema>;
export type BootstrapProjection = z.infer<typeof projectionSchema>;

/** Unknown mutation outcomes are reconciled; they are never transport-retried. */
export function bootstrapRpc(input: BootstrapWorkerInput, deadline: number) {
  return async (name: string, args: Record<string, unknown>, parent?: AbortSignal): Promise<unknown> => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new BootstrapFailure("budget_exhausted");
    const signal = AbortSignal.any([AbortSignal.timeout(Math.min(4_000, remaining)), ...(parent ? [parent] : [])]);
    let envelope: unknown;
    try { envelope = await awaitWithAbort(() => input.rpc(name, args, signal), signal); }
    catch { throw new BootstrapFailure("provider_error"); }
    const parsed = z.object({ data: z.unknown(), error: z.null() }).safeParse(envelope);
    if (!parsed.success || !Object.hasOwn(parsed.data, "data")) throw new BootstrapFailure("provider_error");
    return parsed.data.data;
  };
}
type Rpc = ReturnType<typeof bootstrapRpc>;
const jobArgs = (job: Executor) => ({ p_job_id: job.job_id, p_lease_id: job.lease_id, p_revision: job.revision });

function usageFetcher(context: { input: BootstrapWorkerInput; rpc: Rpc; runId: string; job: Executor; deadline: number;
  recordRetry: (retryAt: string) => void }): typeof fetch {
  const { input, rpc, runId, job, deadline, recordRetry } = context;
  return async (request, init) => {
    const response = await (input.fetcher ?? fetch)(request, init);
    const parent = init?.signal ?? (request instanceof Request ? request.signal : undefined);
    // The adapter's signal already covers headers and body. Inspection and its
    // durable usage write must share that remaining budget, without a new ceiling.
    const signal = AbortSignal.any([AbortSignal.timeout(Math.max(1, deadline - Date.now())), ...(parent ? [parent] : [])]);
    const { usage, pause, retryAt: retry } = await metaResponseThrottle(response, signal);
    if (usage || pause) {
      const recorded = await rpc("record_analytics_legacy_bootstrap_usage", { p_run_id: runId, p_job_id: job.job_id,
        p_usage: usage, p_retry_at: retry, p_app_id: input.apps[job.capture.login_kind === "direct" ? "instagram" : "facebook"].id }, signal);
      if (recorded !== null) throw new BootstrapFailure("provider_error");
      if (pause) {
        if (retry) recordRetry(retry);
        void response.body?.cancel().catch(() => undefined);
        return Response.json({ error: { code: 4, is_transient: true } }, { status: 429 });
      }
    }
    return response;
  };
}

async function settleFailure(rpc: Rpc, job: Executor, reason: BootstrapReason, retryAt?: string): Promise<BootstrapProjection> {
  // SQL accepts at most seven days per job; the separate app pause retains the full provider deadline.
  const jobRetryAt = retryAt ? new Date(Math.min(Date.parse(retryAt), Date.now() + 7 * 86_400_000)).toISOString() : undefined;
  return projectionSchema.parse(await rpc("settle_analytics_legacy_bootstrap", { ...jobArgs(job), p_reason: reason,
    ...(jobRetryAt ? { p_retry_at: jobRetryAt } : {}) }));
}

async function repairAccount(context: { input: BootstrapWorkerInput; rpc: Rpc; runId: string; accountId: string; deadline: number }): Promise<BootstrapProjection> {
  const { input, rpc, runId, accountId, deadline } = context;
  const key = crypto.randomUUID();
  const begun = await rpc("begin_analytics_legacy_bootstrap", { p_account_id: accountId, p_idempotency_key: key, p_run_id: runId });
  const projected = projectionSchema.parse(begun);
  if (!["verifying", "permission_pending"].includes(projected.state)) return projected;
  const parsed = executorSchema.safeParse(begun);
  // A settled/busy response deliberately carries no secret executor projection.
  if (!parsed.success) return projected;
  const job = parsed.data;
  const beforeRequest = async () => {
    if (Date.now() >= deadline) throw new BootstrapFailure("budget_exhausted");
    if (await rpc("permit_analytics_legacy_bootstrap", { ...jobArgs(job), p_run_id: runId,
      p_app_id: input.apps[job.capture.login_kind === "direct" ? "instagram" : "facebook"].id }) !== true) throw new BootstrapFailure("budget_exhausted");
  };
  let retryAt: string | undefined;
  const fetcher = usageFetcher({ input, rpc, runId, job, deadline, recordRetry: (retry) => { retryAt = retry; } });
  try {
    if (!job.installed) {
      const evidence = await verifyLegacyAuthority({ capture: job.capture,
        app: input.apps[job.capture.login_kind === "direct" ? "instagram" : "facebook"], deadline, beforeRequest, fetcher });
      let installed: BootstrapProjection;
      try {
        installed = projectionSchema.parse(await rpc("commit_analytics_legacy_bootstrap", { ...jobArgs(job), p_evidence: evidence }));
        if (!installed.installed && ["identity_mismatch", "app_mismatch", "token_invalid"].includes(installed.reason_code ?? "")) {
          return await settleFailure(rpc, job, installed.reason_code as "identity_mismatch" | "app_mismatch" | "token_invalid");
        }
      }
      catch {
        installed = projectionSchema.parse(await rpc("reconcile_analytics_legacy_bootstrap", { p_account_id: accountId, p_idempotency_key: key }));
      }
      if (!installed.installed || installed.state !== "permission_pending" || !installed.revision) return installed;
      job.revision = installed.revision;
      job.installed = true;
    }
    const observedAt = new Date().toISOString();
    let permissions: { state: "ok" | "failed"; scopes: string[]; observed_at: string };
    try {
      const scopes = await readPageLinkedPermissions(job.capture.token, fetcher, { deadline, beforeRequest,
        origin: job.capture.login_kind === "direct" ? "https://graph.instagram.com" : "https://graph.facebook.com",
        version: job.capture.platform === "facebook" ? "v25.0" : "v22.0" });
      permissions = { state: "ok", scopes, observed_at: observedAt };
    } catch (error) {
      if (error instanceof BootstrapFailure) throw error;
      if (error instanceof MetaPermissionReadFailure && error.reason === "rate_limited") throw new BootstrapFailure("rate_limited");
      if (error instanceof MetaPermissionReadFailure && ["token_invalid", "permission_missing"].includes(error.reason)) {
        throw new BootstrapFailure(error.reason as "token_invalid" | "permission_missing");
      }
      if (error instanceof MetaPermissionReadFailure && error.reason === "unsupported" && job.capture.login_kind === "direct") {
        throw new BootstrapFailure("direct_verification_unsupported");
      }
      permissions = { state: "failed", scopes: [], observed_at: observedAt };
    }
    try { return projectionSchema.parse(await rpc("complete_analytics_legacy_bootstrap", { ...jobArgs(job), p_permissions: permissions })); }
    catch { return projectionSchema.parse(await rpc("reconcile_analytics_legacy_bootstrap", { p_account_id: accountId, p_idempotency_key: key })); }
  } catch (error) {
    return await settleFailure(rpc, job, error instanceof BootstrapFailure ? error.reason : "provider_malformed", retryAt);
  }
}

/** One global leased worker; at most five sequential accounts and forty seconds including reconciliation. */
export async function runLegacyBootstrap(input: BootstrapWorkerInput): Promise<{ status: string; accounts: BootstrapProjection[] }> {
  const deadline = Math.min(input.deadline ?? Infinity, Date.now() + 40_000);
  const rpc = bootstrapRpc(input, deadline);
  const runId = crypto.randomUUID();
  const dispatch = z.object({ status: z.string(), account_ids: z.array(z.string().uuid()).max(5) })
    .parse(await rpc("dispatch_analytics_legacy_bootstrap", { p_run_id: runId }));
  const accounts: BootstrapProjection[] = [];
  for (const accountId of dispatch.account_ids) {
    if (Date.now() >= deadline - 5_000) break;
    accounts.push(await repairAccount({ input, rpc, runId, accountId, deadline: deadline - 5_000 }));
    if (["app_mismatch", "identity_mismatch", "rate_limited"].includes(accounts.at(-1)?.reason_code ?? "")) break;
  }
  return { status: dispatch.status, accounts };
}
