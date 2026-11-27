import type { YouTubeAnalyticsBreakdownOperation, YouTubeAnalyticsPeriodDays } from "../domain/types";
import type { YouTubeAnalyticsGateway } from "./ports";
import { useYouTubeAnalyticsReportQuery } from "./reportQuery";

/**
 * A channel-level breakdown (traffic sources, geography or devices).
 *
 * The query stays disabled until the owning tab is opened for the first time,
 * so opening the analytics screen keeps costing exactly what it cost before
 * the breakdowns existed.
 */
export function useYouTubeAnalyticsBreakdown(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  periodDays: YouTubeAnalyticsPeriodDays;
  operation: YouTubeAnalyticsBreakdownOperation;
  enabled: boolean;
  onError: (error: unknown) => void;
}) {
  return useYouTubeAnalyticsReportQuery({ ...params, videoId: null });
}
