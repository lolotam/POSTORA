import type { AnalyticsPeriodDays, AnalyticsPlatform, AnalyticsReport } from "../domain/types";

export type AnalyticsAccount = { id: string; name: string; active: boolean };
export type SavedReportRequest = { platform: AnalyticsPlatform; accountId: string; periodDays: AnalyticsPeriodDays; cursor: string | null };
export type SavedAnalyticsGateway = {
  accounts(ownerId: string, platform: AnalyticsPlatform): Promise<AnalyticsAccount[]>;
  report(request: SavedReportRequest): Promise<AnalyticsReport>;
};

export class AnalyticsReadError extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "AnalyticsReadError"; }
}
