/**
 * Composition root for `instagram-insights-report`.
 *
 * Exposes authenticated owner report endpoint:
 *   GET /functions/v1/instagram-insights-report?social_account_id=...&period_days=30
 *   POST /functions/v1/instagram-insights-report
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller, serviceRoleCallerUserId } from "../_shared/auth-helper.ts";
import { createInstagramInsightsReportHandler } from "./handler.ts";
import { ReportStore, type ReportStoreClient } from "./reportStore.ts";
import { awaitWithAbort } from "../_shared/abort.ts";
import { jsonResponse } from "../_shared/cors.ts";

function getClient() {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  if (!url || !serviceKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }
  return createClient(url, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

let storeInstance: ReportStore | null = null;
function getStore(): ReportStore {
  if (!storeInstance) {
    storeInstance = new ReportStore(getClient() as unknown as ReportStoreClient);
  }
  return storeInstance;
}

const reportHandler = createInstagramInsightsReportHandler({
  authenticate: async (req: Request) => {
    return await authenticateCaller(req, await serviceRoleCallerUserId(req));
  },
  store: {
    loadAccount: (socialAccountId: string, userId: string) =>
      getStore().loadAccount(socialAccountId, userId),
    loadReportData: (
      socialAccountId: string,
      userId: string,
      request: Parameters<ReportStore["loadReportData"]>[2],
      now: Date
    ) => getStore().loadReportData(socialAccountId, userId, request, now),
  } as unknown as ReportStore,
});

export async function handler(req: Request): Promise<Response> {
  const response = await reportHandler(req);
  if (req.method === "OPTIONS") return response;
  const signal = AbortSignal.timeout(5_000);
  try {
    const receipt = await awaitWithAbort(() => getClient().from("system_logs").insert({
      level: response.ok ? "info" : "warn", category: "edge", source: "instagram-insights-report",
      message: "Instagram saved report finished", metadata: { status: response.status },
    }).abortSignal(signal), signal);
    if (receipt.error) throw new Error("Report audit unavailable");
    return response;
  } catch {
    return jsonResponse({ ok: false, reason: "audit_unavailable",
      error: { code: "HISTORY_UNAVAILABLE", message: "Report read could not be recorded. Please retry." } }, 503);
  }
}

if (import.meta.main) {
  Deno.serve((request: Request) => handler(request));
}
