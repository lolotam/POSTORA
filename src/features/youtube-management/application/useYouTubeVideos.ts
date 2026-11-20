import { useInfiniteQuery, type InfiniteData, type UseInfiniteQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { YouTubeResourceSuccess, YouTubeVideosPage } from "../domain/types";
import type { YouTubeResourcesGateway } from "./ports";
import { YOUTUBE_RESOURCE_STALE_MS, youtubeResourceKey, youtubeResourceRetry } from "./queryKeys";

export function useYouTubeVideos(options: { gateway: YouTubeResourcesGateway; accountId: string | null; enabled: boolean }): UseInfiniteQueryResult<InfiniteData<YouTubeResourceSuccess<YouTubeVideosPage>, string | null>, Error> {
  const { gateway, accountId, enabled } = options;
  const user = useAuth().user;
  const userId = user?.id ?? "anonymous";
  return useInfiniteQuery<YouTubeResourceSuccess<YouTubeVideosPage>, Error, InfiniteData<YouTubeResourceSuccess<YouTubeVideosPage>, string | null>, readonly unknown[], string | null>({
    queryKey: youtubeResourceKey(userId, accountId, "videos"),
    queryFn: ({ pageParam }) => gateway.listVideos({ accountId: accountId as string, pageToken: pageParam }),
    // An empty page may still carry next_page_token: paginate on the token,
    // never on items.length.
    getNextPageParam: (last) => last.data.next_page_token ?? undefined,
    initialPageParam: null as string | null,
    enabled: Boolean(enabled && accountId && user?.id),
    staleTime: YOUTUBE_RESOURCE_STALE_MS,
    refetchOnWindowFocus: false,
    retry: youtubeResourceRetry,
  });
}
