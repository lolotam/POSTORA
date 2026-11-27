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

/**
 * Operations that describe the whole channel. They never carry a video in the
 * query key, so a channel-level report and a per-video report of the same
 * operation can never share a cache entry.
 */
const CHANNEL_LEVEL_OPERATIONS: readonly YouTubeAnalyticsDataOperation[] = [
  "top_videos",
  "traffic_sources",
  "geography",
  "devices",
];

/**
 * Operations that only make sense for one video. `retention` is a report about
 * a single video's audience curve, so it is never requested without one.
 */
const REQUIRES_VIDEO_OPERATIONS: readonly YouTubeAnalyticsDataOperation[] = ["retention"];

interface ReportRequest {
  accountId: string;
  periodDays: YouTubeAnalyticsPeriodDays;
  windowEnd: string;
  videoId?: string;
  signal?: AbortSignal;
}

/**
 * One dispatch point for every report operation, so the hook below never has
 * to know which gateway method belongs to which operation.
 */
async function fetchReport(
  gateway: YouTubeAnalyticsGateway,
  operation: YouTubeAnalyticsDataOperation,
  request: ReportRequest,
): Promise<unknown> {
  switch (operation) {
    case "summary":
      return gateway.summary(request);
    case "daily":
      return gateway.daily(request);
    case "top_videos":
      return gateway.topVideos(request);
    case "traffic_sources":
      return gateway.trafficSources(request);
    case "geography":
      return gateway.geography(request);
    case "devices":
      return gateway.devices(request);
    case "retention": {
      if (!request.videoId) throw new YouTubeAnalyticsClientError("internal_error");
      return gateway.retention({ ...request, videoId: request.videoId });
    }
    default:
      throw new YouTubeAnalyticsClientError("internal_error");
  }
}

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
  const isChannelLevel = CHANNEL_LEVEL_OPERATIONS.includes(operation);
  const ready = enabled
    && Boolean(accountId && connectionRevision && windowEnd)
    && (!REQUIRES_VIDEO_OPERATIONS.includes(operation) || Boolean(videoId));
  const queryKey = youtubeAnalyticsQueryKey(
    userId,
    accountId ?? "",
    connectionRevision ?? "",
    operation,
    windowEnd ?? "",
    periodDays,
    isChannelLevel ? null : videoId,
  );
  const queryState = queryClient.getQueryState(queryKey);
  const hasCachedError = queryState?.status === "error" || (queryState?.error !== undefined && queryState.error !== null);
  const query = useQuery({
    queryKey,
    queryFn: async ({ signal }): Promise<YouTubeAnalyticsSuccess<YouTubeAnalyticsDataForOperation[Operation]>> => {
      const response = await fetchReport(gateway, operation, {
        accountId: accountId!,
        periodDays,
        windowEnd: windowEnd!,
        ...(isChannelLevel || !videoId ? {} : { videoId }),
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
