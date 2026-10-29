import type { OwnerReport, OwnerReportCursor, OwnerReportPeriodDays } from "../domain/types";

export type GetReportParams = {
  socialAccountId: string;
  periodDays: OwnerReportPeriodDays;
  limit?: number;
  cursor?: OwnerReportCursor | null;
};

export type TriggerSyncParams = {
  socialAccountId: string;
};

export type TriggerSyncResult = {
  jobId: string;
  status: "queued" | "completed" | "failed";
  message?: string;
};

export interface InstagramInsightsGateway {
  getReport(params: GetReportParams): Promise<OwnerReport>;
  triggerSync(params: TriggerSyncParams): Promise<TriggerSyncResult>;
}
