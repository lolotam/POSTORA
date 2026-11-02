import { z } from "https://esm.sh/zod@3.25.76";
import { awaitWithAbort } from "../_shared/abort.ts";
import { readJsonBodyCapped } from "../_shared/cappedJsonBody.ts";
import { handleRestrictedCorsOptions, restrictedJsonResponse } from "../_shared/cors.ts";
import { persistedOwnedAnalyticsReport } from "./report.ts";
import { PersistedReportRefused, type StoredAnalyticsRpc } from "./store.ts";

const requestSchema = z.object({ platform: z.enum(["facebook", "threads"]), accountId: z.string().uuid(), analyticsContractVersion: z.unknown(),
  periodDays: z.union([z.literal(7), z.literal(14), z.literal(30), z.literal(90)]).default(7),
  cursor: z.string().min(1).max(16384).nullable().optional(), user_id: z.string().uuid().optional() }).strict();
export type StoredReportAudit = { event: "persisted_report_read" | "persisted_report_refused"; reason: string | null; status: number;
  ownerId: string | null; platform: "facebook" | "threads" | null; accountId: string | null };
export type StoredReportHandlerDeps = { authenticate: (req: Request, actingUserId: string | undefined) => Promise<{ userId: string }>;
  rpc: StoredAnalyticsRpc; secret: string; audit: (event: StoredReportAudit, signal: AbortSignal) => PromiseLike<boolean> };

export function createStoredReportHandler(deps: StoredReportHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (req.method === "OPTIONS") return handleRestrictedCorsOptions(req);
    const signal = AbortSignal.any([req.signal, AbortSignal.timeout(20_000)]);
    let ownerId: string | null = null;
    let platform: "facebook" | "threads" | null = null;
    let accountId: string | null = null;
    const finish = async (status: number, body: unknown, reason: string | null) => {
      let stored = false;
      try { stored = await awaitWithAbort(() => deps.audit({ event: status === 200 ? "persisted_report_read" : "persisted_report_refused",
        status, reason, ownerId, platform, accountId }, AbortSignal.timeout(5_000)), AbortSignal.timeout(5_000)); } catch { stored = false; }
      return restrictedJsonResponse(req, stored ? body : { ok: false, reason: "audit_unavailable", message: "The analytics read could not be recorded. Please retry." }, stored ? status : 503);
    };
    try {
      if (req.method !== "POST") return await finish(405, { ok: false, reason: "method_not_allowed", message: "Use POST for saved analytics." }, "method_not_allowed");
      const body = await awaitWithAbort(() => readJsonBodyCapped(req, 8192, signal), signal);
      const parsed = requestSchema.safeParse(body.ok ? body.value : null);
      if (!parsed.success) return await finish(400, { ok: false, reason: "invalid_request", message: "Invalid saved analytics request." }, "invalid_request");
      let auth: { userId: string };
      try { auth = await awaitWithAbort(() => deps.authenticate(req, parsed.data.user_id), signal); }
      catch (error) {
        if (error instanceof PersistedReportRefused) throw error;
        if (signal.aborted) throw new PersistedReportRefused("storage_unavailable", 503);
        return await finish(401, { ok: false, reason: "unauthorized", message: "Unauthorized." }, "unauthorized");
      }
      const owner = z.string().uuid().safeParse(auth.userId);
      if (!owner.success) return await finish(401, { ok: false, reason: "unauthorized", message: "Unauthorized." }, "unauthorized");
      ownerId = owner.data.toLowerCase(); platform = parsed.data.platform; accountId = parsed.data.accountId.toLowerCase();
      if (parsed.data.analyticsContractVersion !== 1) return await finish(400, { ok: false, reason: "unsupported_contract_version", message: "Unsupported analytics contract version." }, "unsupported_contract_version");
      const report = await persistedOwnedAnalyticsReport({ scope: { platform, ownerId, accountId, days: parsed.data.periodDays },
        cursor: parsed.data.cursor ?? null, secret: deps.secret, now: new Date().toISOString(), rpc: deps.rpc, signal });
      return await finish(200, report, null);
    } catch (error) {
      const refused = error instanceof PersistedReportRefused ? error : new PersistedReportRefused("storage_unavailable", 503);
      return await finish(refused.status, { ok: false, reason: refused.reason, message: refused.reason === "account_not_found" ? "Account not found." : "Saved analytics could not be read. Please retry." }, refused.reason);
    }
  };
}
