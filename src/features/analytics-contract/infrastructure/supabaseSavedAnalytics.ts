import { supabase } from "@/integrations/supabase/client";
import { parseAnalyticsReport } from "../../../../supabase/functions/_shared/analyticsSchema.ts";
import { AnalyticsReadError, type SavedAnalyticsGateway } from "../application/ports";

async function refusal(error: unknown): Promise<AnalyticsReadError> {
  const context = (error as { context?: unknown } | null)?.context;
  if (context instanceof Response) {
    const body: unknown = await context.clone().json().catch(() => null);
    if (body && typeof body === "object" && "reason" in body && typeof body.reason === "string") return new AnalyticsReadError(body.reason);
  }
  return new AnalyticsReadError("storage_unavailable");
}

export const supabaseSavedAnalytics: SavedAnalyticsGateway = {
  async accounts(ownerId, platform) {
    const { data, error } = await supabase.from("social_accounts").select("id,platform_username,platform_user_id,is_active")
      .eq("user_id", ownerId).eq("platform", platform).order("connected_at");
    if (error || !data) throw new AnalyticsReadError("accounts_unavailable");
    return data.map((account) => ({ id: account.id, name: account.platform_username ?? account.platform_user_id, active: account.is_active === true }));
  },
  async report(request) {
    const instagram = request.platform === "instagram";
    const { data, error } = await supabase.functions.invoke<unknown>(instagram ? "instagram-insights-report" : "meta-owned-analytics-report", {
      body: instagram ? { social_account_id: request.accountId, period_days: request.periodDays, analyticsContractVersion: 1, cursor: request.cursor }
        : { platform: request.platform, accountId: request.accountId, periodDays: request.periodDays, analyticsContractVersion: 1, cursor: request.cursor },
    });
    if (error) throw await refusal(error);
    if (data && typeof data === "object" && "ok" in data && data.ok === false) {
      throw new AnalyticsReadError("reason" in data && typeof data.reason === "string" ? data.reason : "storage_unavailable");
    }
    try {
      const report = parseAnalyticsReport(data);
      if (report.accountId !== request.accountId || report.platform !== request.platform || report.source !== "persisted" || report.period.days !== request.periodDays) {
        throw new AnalyticsReadError("invalid_contract");
      }
      return report;
    } catch { throw new AnalyticsReadError("invalid_contract"); }
  },
};
