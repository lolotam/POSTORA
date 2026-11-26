import { useEffect, useMemo } from "react";
import {
  useInfiniteQuery,
  useQueryClient,
  type InfiniteData,
  type QueryClient,
  type QueryKey,
} from "@tanstack/react-query";
import type { YouTubeAnalyticsPeriodDays, YouTubeAnalyticsSuccess, YouTubeAnalyticsTopVideosData } from "../domain/types";
import { YouTubeAnalyticsClientError } from "../domain/errors";
import type { YouTubeAnalyticsGateway } from "./ports";
import { youtubeAnalyticsQueryKey } from "./queryKeys";

export type YouTubeTopVideosPage = YouTubeAnalyticsSuccess<YouTubeAnalyticsTopVideosData>;
export type YouTubeTopVideosInfiniteData = InfiniteData<YouTubeTopVideosPage, unknown>;

export function trimTopVideosToFirstPage(queryClient: QueryClient, key: QueryKey): void {
  queryClient.setQueryData<InfiniteData<YouTubeTopVideosPage, number>>(key, (current) => {
    if (!current) return undefined;
    return { pages: [current.pages[0]], pageParams: [1] };
  });
}

export function useYouTubeTopVideos(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  connectionRevision: string | null;
  windowEnd: string | null;
  periodDays: YouTubeAnalyticsPeriodDays;
  enabled: boolean;
  onError: (error: unknown) => void;
}) {
  const {
    gateway, userId, accountId, connectionRevision, windowEnd, periodDays, enabled, onError,
  } = params;
  const queryClient = useQueryClient();
  const ready = enabled && Boolean(accountId && connectionRevision && windowEnd);
  const queryKey = useMemo(() => youtubeAnalyticsQueryKey(
    userId,
    accountId ?? "",
    connectionRevision ?? "",
    "top_videos",
    windowEnd ?? "",
    periodDays,
    null,
  ), [userId, accountId, connectionRevision, windowEnd, periodDays]);
  const queryState = queryClient.getQueryState(queryKey);
  const hasCachedError = queryState?.status === "error" || (queryState?.error !== undefined && queryState.error !== null);
  const query = useInfiniteQuery({
    queryKey,
    queryFn: async ({ signal, pageParam }): Promise<YouTubeTopVideosPage> => {
      const response = await gateway.topVideos({
        accountId: accountId!,
        periodDays,
        windowEnd: windowEnd!,
        startIndex: pageParam,
        signal,
      });
      if (response.connection_revision !== connectionRevision
        || response.requested_window?.end_date !== windowEnd
        || response.requested_window.days !== periodDays) {
        throw new YouTubeAnalyticsClientError("internal_error", { requestId: response.request_id });
      }
      return response;
    },
    initialPageParam: 1,
    getNextPageParam: (last) => last.data.next_start_index ?? undefined,
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

  return { ...query, queryKey };
}
