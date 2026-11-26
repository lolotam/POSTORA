import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { YouTubeAnalyticsGateway } from "./ports";
import { youtubeAnalyticsQueryKey } from "./queryKeys";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import type {
  YouTubeAnalyticsDataForOperation,
  YouTubeAnalyticsDataOperation,
  YouTubeAnalyticsPeriodDays,
  YouTubeAnalyticsSuccess,
} from "../domain/types";

export function useYouTubeAnalyticsReportQuery<Operation extends YouTubeAnalyticsDataOperation>(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  periodDays: YouTubeAnalyticsPeriodDays;
  operation: Operation;
  videoId?: string | null;
  enabled: boolean;
  onError: (error: unknown) => void;
}) {
  const {
    gateway, userId, accountId, connectionRevision, windowEnd, periodDays,
    operation, videoId = null, enabled, onError,
  } = params;
  const queryClient = useQueryClient();
  const ready = enabled && Boolean(accountId && connectionRevision && windowEnd);
  const queryKey = youtubeAnalyticsQueryKey(
    userId,
    accountId ?? "",
    connectionRevision ?? "",
    operation,
    windowEnd ?? "",
    periodDays,
    operation === "top_videos" ? null : videoId,
  );
  const queryState = queryClient.getQueryState(queryKey);
  const hasCachedError = queryState?.status === "error" || (queryState?.error !== undefined && queryState.error !== null);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsDataForOperation[Operation]>> => {
      const fetchReport = operation === "summary"
        ? gateway.summary
        : operation === "daily"
          ? gateway.daily
          : gateway.topVideos;
      const response = await fetchReport({
        accountId: accountId!,
        periodDays,
        windowEnd: windowEnd!,
        ...(operation !== "top_videos" && videoId ? { videoId } : {}),
        signal,
      }) as YouTubeAnalyticsSuccess<YouTubeAnalyticsDataForOperation[Operation]>;
      if (response.connection_revision !== connectionRevision
        || response.requested_window?.end_date !== windowEnd
        || response.requested_window.days !== periodDays) {
        throw new YouTubeAnalyticsClientError("internal_error", { requestId: response.request_id });
      }
      return response;
    },
    enabled: ready && !hasCachedError,
    staleTime: Infinity,
    gcTime: Infinity,
    refetchOnMount: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });

  useEffect(() => {
    if (query.error) onError(query.error);
  }, [onError, query.error]);

  return query;
}
