import { supabase } from "@/integrations/supabase/client";
import { parseOwnerReportCursor } from "../../../../supabase/functions/instagram-insights-report/contracts";
import { invokeErrorMessage } from "@/lib/functionInvokeError";
import type {
  GetReportParams,
  InstagramInsightsGateway,
  TriggerSyncParams,
  TriggerSyncResult,
} from "../application/ports";
import type { OwnerReport } from "../domain/types";

export class SupabaseInstagramInsightsGateway implements InstagramInsightsGateway {
  async getReport(params: GetReportParams): Promise<OwnerReport> {
    const { data, error } = await supabase.functions.invoke<OwnerReport>(
      "instagram-insights-report",
      {
        body: {
          social_account_id: params.socialAccountId,
          period_days: params.periodDays,
          limit: params.limit,
          cursor: parseOwnerReportCursor(params.cursor) ?? undefined,
        },
      },
    );

    if (error) {
      throw new Error(await invokeErrorMessage(error, "Failed to load Instagram insights report"));
    }

    if (!data) {
      throw new Error("No data returned from Instagram insights report service");
    }

    return data;
  }

  async triggerSync(params: TriggerSyncParams): Promise<TriggerSyncResult> {
    const { data, error } = await supabase.functions.invoke<{
      job_id?: string;
      status?: string;
      error?: string;
      message?: string;
    }>("instagram-insights-sync", {
      body: {
        action: "enqueue",
        social_account_id: params.socialAccountId,
        mode: "normal",
      },
    });

    if (error) {
      throw new Error(await invokeErrorMessage(error, "Failed to trigger Instagram insights collection"));
    }

    if (data?.error) {
      throw new Error(data.error);
    }

    return {
      jobId: data?.job_id || "queued",
      status: (data?.status as "queued" | "completed" | "failed") || "queued",
      message: data?.message,
    };
  }
}

export const defaultInstagramInsightsGateway = new SupabaseInstagramInsightsGateway();
