import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { YouTubeChannelDetails, YouTubeResourceSuccess } from "../domain/types";
import type { YouTubeResourcesGateway } from "./ports";
import { YOUTUBE_RESOURCE_STALE_MS, youtubeResourceKey, youtubeResourceRetry } from "./queryKeys";

export function useYouTubeChannel(options: { gateway: YouTubeResourcesGateway; accountId: string | null; enabled: boolean }): UseQueryResult<YouTubeResourceSuccess<YouTubeChannelDetails>, Error> {
  const { gateway, accountId, enabled } = options;
  const user = useAuth().user;
  const userId = user?.id ?? "anonymous";
  return useQuery<YouTubeResourceSuccess<YouTubeChannelDetails>, Error>({
    queryKey: youtubeResourceKey(userId, accountId, "channel"),
    queryFn: () => gateway.getChannel(accountId as string),
    enabled: Boolean(enabled && accountId && user?.id),
    staleTime: YOUTUBE_RESOURCE_STALE_MS,
    refetchOnWindowFocus: false,
    retry: youtubeResourceRetry,
  });
}
