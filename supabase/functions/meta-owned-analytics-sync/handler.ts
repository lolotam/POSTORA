import { z } from "https://esm.sh/zod@3.25.76";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { awaitWithAbort } from "../_shared/abort.ts";
import { admitOwnedAnalyticsAccount } from "./admission.ts";
import { dispatchOwnedAnalyticsDaily, type DispatchCounts } from "./dispatch.ts";
import { drainOwnedAnalytics, type DrainCounts } from "./worker.ts";
import { retainOwnedAnalytics, retentionContinuation, type RetentionContinuation, type RetentionCounts } from "./retention.ts";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import type { AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsStore, type AnalyticsRpc, type OwnedAnalyticsPlatform } from "./store.ts";

const syncRequest = z.discriminatedUnion("action", [
  z.object({ action: z.literal("enqueue"), user_id: z.string().uuid(), platform: z.enum(["facebook", "threads"]), accountId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("admit"), platform: z.enum(["facebook", "threads"]), accountId: z.string().uuid() }).strict(),
  z.object({ action: z.literal("enqueue-daily"), platform: z.enum(["facebook", "threads", "all"]) }).strict(),
  z.object({ action: z.literal("drain"), platform: z.enum(["facebook", "threads", "all"]) }).strict(),
  z.object({ action: z.literal("retention"), platform: z.enum(["facebook", "threads", "all"]), dryRun: z.boolean(), continuation: retentionContinuation.optional() }).strict(),
]).refine((input) => input.action !== "retention" || input.dryRun || input.continuation === undefined,
  { message: "Continuation is only valid for retention dry runs" });
type WorkCounts = DispatchCounts | DrainCounts | RetentionCounts;
export type OwnedAnalyticsAudit = { event: "owned_analytics_enqueue" | "owned_analytics_admission" | "owned_analytics_dispatch" | "owned_analytics_drain" | "owned_analytics_retention"; status: string; reason: string | null;
  platform: OwnedAnalyticsPlatform | "all" | null; accountId: string | null; dryRun?: boolean; retentionFloor?: string; counts?: WorkCounts };
export type OwnedAnalyticsSyncDeps = {
  authorizeEnqueue?: (req: Request, userId: string) => Promise<boolean>;
  authorize: (req: Request) => { ok: true } | { ok: false; status: 401 | 503 };
  app: (platform: OwnedAnalyticsPlatform) => AdmissionApp | null;
  rpc: AnalyticsRpc;
  audit: (event: OwnedAnalyticsAudit, signal: AbortSignal) => PromiseLike<boolean>;
  fetch?: typeof fetch;
};

async function readSyncBody(req: Request, deadline: AnalyticsWorkerDeadline): Promise<unknown> {
  if (!req.body) return null;
  const reader = req.body.getReader();
  let completed = false;
  try {
    return await deadline.run(async (signal) => {
      const chunks: Uint8Array[] = [];
      let length = 0;
      while (!signal.aborted) {
        const part = await reader.read();
        if (part.done) {
          completed = true;
          const bytes = new Uint8Array(length);
          let position = 0;
          for (const chunk of chunks) { bytes.set(chunk, position); position += chunk.byteLength; }
          try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
          catch (error) {
            if (error instanceof SyntaxError || error instanceof TypeError) return null;
            throw error;
          }
        }
        length += part.value.byteLength;
        if (length > 8192) return null;
        chunks.push(part.value);
      }
      throw new AnalyticsWorkerStopped("deadline");
    });
  } finally {
    if (!completed) void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** Internal action authority and strict request decoding precede every account operation. */
export function createOwnedAnalyticsSyncHandler(deps: OwnedAnalyticsSyncDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
    const deadline = new AnalyticsWorkerDeadline(Date.now(), req.signal);
    let platform: OwnedAnalyticsPlatform | "all" | null = null;
    let action: "enqueue" | "admit" | "enqueue-daily" | "drain" | "retention" = "admit";
    let dryRun: boolean | null = null;
    let retentionFloor: string | null = null;
    let accountId: string | null = null;
    let enqueueReceipt: Record<string, unknown> | null = null;
    const finish = async (statusCode: number, status: string, reason: string | null = null,
      details?: { counts: WorkCounts; continuation?: RetentionContinuation | null }) => {
      const { counts, continuation } = details ?? {};
      let auditStored = false;
      const event = { enqueue: "owned_analytics_enqueue", admit: "owned_analytics_admission", "enqueue-daily": "owned_analytics_dispatch", drain: "owned_analytics_drain", retention: "owned_analytics_retention" } as const;
      // A disconnected caller must not erase the terminal refusal receipt.
      // Work stops within 40 seconds; this independent audit has a 5-second cap.
      const auditSignal = AbortSignal.timeout(5_000);
      try { auditStored = await awaitWithAbort(() => deps.audit({ event: event[action],
        status, reason, platform, accountId, ...(dryRun === null ? {} : { dryRun }), ...(retentionFloor ? { retentionFloor } : {}), ...(counts ? { counts } : {}) }, auditSignal), auditSignal); }
      catch { auditStored = false; }
      return restrictedJsonResponse(req, { ok: (action === "enqueue" ? statusCode >= 200 && statusCode < 300 && !["collection_disabled", "not_eligible"].includes(status) : statusCode === 200) && auditStored, action, platform, status,
        reason: auditStored ? reason : "audit_unavailable", auditStored, ...(enqueueReceipt ?? {}), ...(dryRun === null ? {} : { dryRun }), ...(counts ? { counts } : {}),
        ...(auditStored && continuation !== undefined ? { continuation } : {}) }, auditStored ? statusCode : 503);
    };
    try {
      if (req.method !== "POST") return await finish(405, "refused", "method_not_allowed");
      const auth = deps.authorize(req);
      const parsed = syncRequest.safeParse(await readSyncBody(req, deadline));
      if (!parsed.success) return await finish(auth.ok ? 400 : auth.status, "refused", auth.ok ? "invalid_request" : "unauthorized");
      if (parsed.data.action === "enqueue") {
        const ownerId = parsed.data.user_id;
        if (!deps.authorizeEnqueue || !await deadline.run(() => deps.authorizeEnqueue!(req, ownerId))) return await finish(401, "refused", "unauthorized");
      } else if (!auth.ok) return await finish(auth.status, "refused", "unauthorized");
      platform = parsed.data.platform;
      action = parsed.data.action;
      const store = new OwnedAnalyticsStore(deps.rpc, deadline);
      if (parsed.data.action === "enqueue") {
        const input = parsed.data;
        accountId = input.accountId.toLowerCase();
        const scope = await store.enqueueScope(input.user_id, input.platform, accountId);
        if (scope.status !== "eligible") return await finish(200, scope.status);
        const app = deps.app(input.platform);
        if (!app) return await finish(503, "unavailable", "app_configuration_unavailable");
        const admitted = await admitOwnedAnalyticsAccount({ platform: input.platform, accountId, app, deadline, fetch: deps.fetch, store });
        if (admitted.status !== "complete") return await finish(admitted.reason === "rate_limited" ? 429 : 409, "not_eligible", admitted.reason);
        enqueueReceipt = await store.enqueueAccount(input.user_id, input.platform, accountId);
        const status = String(enqueueReceipt.status);
        return await finish(status === "throttled" ? 429 : status === "queued" ? 202 : 200, status);
      }
      if (parsed.data.action === "retention") {
        dryRun = parsed.data.dryRun;
        const result = await retainOwnedAnalytics({ platform: parsed.data.platform, dryRun, continuation: parsed.data.continuation, store, deadline });
        retentionFloor = result.floor;
        return await finish(result.status === "unavailable" ? 503 : 200, result.status, result.reason, { counts: result.counts, continuation: result.continuation });
      }
      if (parsed.data.action === "enqueue-daily") {
        const result = await dispatchOwnedAnalyticsDaily({ platform: parsed.data.platform, store, deadline, app: deps.app, fetch: deps.fetch });
        return await finish(result.status === "unavailable" ? 503 : 200, result.status, result.reason, { counts: result.counts });
      }
      if (parsed.data.action === "drain") {
        const result = await drainOwnedAnalytics({ platform: parsed.data.platform, store, deadline, app: deps.app, fetch: deps.fetch });
        return await finish(result.status === "unavailable" ? 503 : 200, result.status, result.reason, { counts: result.counts });
      }
      accountId = parsed.data.accountId.toLowerCase();
      const app = deps.app(parsed.data.platform);
      if (!app) return await finish(503, "unavailable", "app_configuration_unavailable");
      const result = await admitOwnedAnalyticsAccount({ platform: parsed.data.platform, accountId, app, deadline, fetch: deps.fetch, store });
      if (result.status === "refused" && result.reason === "rate_limited") return await finish(429, "unavailable", result.reason);
      return await finish(result.status === "complete" ? 200 : 409, result.status, result.status === "refused" ? result.reason : null);
    } catch (error) {
      if (action === "enqueue" && error instanceof AnalyticsWorkerStopped && error.sqlstate === "MAH02") return await finish(404, "not_found");
      const reason = error instanceof AnalyticsWorkerStopped ? error.reason : "storage_unavailable";
      return await finish(reason === "admission_refused" ? 409 : 503, reason === "admission_refused" ? "refused" : "unavailable", reason);
    }
  };
}
