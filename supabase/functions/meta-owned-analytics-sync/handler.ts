import { z } from "https://esm.sh/zod@3.25.76";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { admitOwnedAnalyticsAccount } from "./admission.ts";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import type { AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsAdmissionStore, type AnalyticsRpc, type OwnedAnalyticsPlatform } from "./store.ts";

const admissionRequest = z.object({ action: z.literal("admit"), platform: z.enum(["facebook", "threads"]), accountId: z.string().uuid() }).strict();
export type OwnedAnalyticsAudit = { event: "owned_analytics_admission"; status: string; reason: string | null;
  platform: OwnedAnalyticsPlatform | null; accountId: string | null };
export type OwnedAnalyticsSyncDeps = {
  authorize: (req: Request) => { ok: true } | { ok: false; status: 401 | 503 };
  app: (platform: OwnedAnalyticsPlatform) => AdmissionApp | null;
  rpc: AnalyticsRpc;
  audit: (event: OwnedAnalyticsAudit, signal: AbortSignal) => PromiseLike<boolean>;
  fetch?: typeof fetch;
};

async function readAdmissionBody(req: Request, deadline: AnalyticsWorkerDeadline): Promise<unknown> {
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

/** Only implemented actions are accepted; dispatch/drain/retention land with their real use cases. */
export function createOwnedAnalyticsSyncHandler(deps: OwnedAnalyticsSyncDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
    const deadline = new AnalyticsWorkerDeadline(Date.now(), req.signal);
    let platform: OwnedAnalyticsPlatform | null = null;
    let accountId: string | null = null;
    const finish = async (statusCode: number, status: string, reason: string | null = null) => {
      let auditStored = false;
      try { auditStored = await deadline.run((signal) => deps.audit({ event: "owned_analytics_admission", status, reason, platform, accountId }, signal), 0); }
      catch { auditStored = false; }
      return restrictedJsonResponse(req, { ok: statusCode === 200 && auditStored, action: "admit", platform, status,
        reason: auditStored ? reason : "audit_unavailable", auditStored }, auditStored ? statusCode : 503);
    };
    try {
      if (req.method !== "POST") return await finish(405, "refused", "method_not_allowed");
      const auth = deps.authorize(req);
      if (!auth.ok) return await finish(auth.status, "refused", "unauthorized");
      const parsed = admissionRequest.safeParse(await readAdmissionBody(req, deadline));
      if (!parsed.success) return await finish(400, "refused", "invalid_request");
      platform = parsed.data.platform;
      accountId = parsed.data.accountId.toLowerCase();
      const app = deps.app(platform);
      if (!app) return await finish(503, "unavailable", "app_configuration_unavailable");
      const result = await admitOwnedAnalyticsAccount({ platform, accountId, app, deadline, fetch: deps.fetch,
        store: new OwnedAnalyticsAdmissionStore(deps.rpc, deadline) });
      return await finish(result.status === "complete" ? 200 : 409, result.status, result.status === "refused" ? result.reason : null);
    } catch (error) {
      const reason = error instanceof AnalyticsWorkerStopped ? error.reason : "storage_unavailable";
      return await finish(reason === "admission_refused" ? 409 : 503, reason === "admission_refused" ? "refused" : "unavailable", reason);
    }
  };
}
