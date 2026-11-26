import type { YouTubeAnalyticsPeriodDays } from "../domain/types";
import type { YouTubeAnalyticsGateway } from "./ports";
import { useYouTubeAnalyticsReportQuery } from "./reportQuery";

export function useYouTubeAnalyticsDaily(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  periodDays: YouTubeAnalyticsPeriodDays;
  videoId?: string | null;
  enabled: boolean;
  onError: (error: unknown) => void;
}) {
  return useYouTubeAnalyticsReportQuery({ ...params, operation: "daily" });
}
