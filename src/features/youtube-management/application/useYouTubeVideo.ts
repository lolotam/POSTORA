import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { YouTubeResourceSuccess, YouTubeVideoDetails } from "../domain/types";
import type { YouTubeResourcesGateway } from "./ports";
import { YOUTUBE_RESOURCE_STALE_MS, youtubeResourceKey, youtubeResourceRetry } from "./queryKeys";

export function useYouTubeVideo(options: { gateway: YouTubeResourcesGateway; accountId: string | null; videoId: string | null; enabled: boolean }): UseQueryResult<YouTubeResourceSuccess<YouTubeVideoDetails>, Error> {
  const { gateway, accountId, videoId, enabled } = options;
  const user = useAuth().user;
  const userId = user?.id ?? "anonymous";
  return useQuery<YouTubeResourceSuccess<YouTubeVideoDetails>, Error>({
    queryKey: youtubeResourceKey(userId, accountId, "video", videoId ?? undefined),
    queryFn: () => gateway.getVideo({ accountId: accountId as string, videoId: videoId as string }),
    enabled: Boolean(enabled && accountId && videoId && user?.id),
    staleTime: YOUTUBE_RESOURCE_STALE_MS,
    refetchOnWindowFocus: false,
    retry: youtubeResourceRetry,
  });
}
