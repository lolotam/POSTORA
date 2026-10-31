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

export const handler = createInstagramInsightsReportHandler({
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

if (import.meta.main) {
  Deno.serve((request: Request) => handler(request));
}
