import type { YouTubeAnalyticsPeriodDays } from "../domain/types";
import type { YouTubeAnalyticsGateway } from "./ports";
import { useYouTubeAnalyticsReportQuery } from "./reportQuery";

/**
 * The audience-retention curve of one video.
 *
 * The query stays disabled until the drawer's retention section is expanded,
 * because the retention report costs an extra Analytics unit and a Data unit
 * on top of the video's summary and daily trend.
 */
export function useYouTubeVideoRetention(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  periodDays: YouTubeAnalyticsPeriodDays;
  videoId: string | null;
  enabled: boolean;
  onError: (error: unknown) => void;
}) {
  return useYouTubeAnalyticsReportQuery({
    ...params,
    operation: "retention",
    enabled: params.enabled && Boolean(params.videoId),
  });
}
