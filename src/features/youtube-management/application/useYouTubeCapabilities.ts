import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { YouTubeAccountCapabilities, YouTubeResourceSuccess } from "../domain/types";
import type { YouTubeResourcesGateway } from "./ports";
import { YOUTUBE_CAPABILITIES_STALE_MS, youtubeResourceKey, youtubeResourceRetry } from "./queryKeys";

// Capabilities gate the whole screen, so it is fetched whenever an account is
// selected; there is no separate `enabled` option.
export function useYouTubeCapabilities(options: { gateway: YouTubeResourcesGateway; accountId: string | null }): UseQueryResult<YouTubeResourceSuccess<YouTubeAccountCapabilities>, Error> {
  const { gateway, accountId } = options;
  const user = useAuth().user;
  const userId = user?.id ?? "anonymous";
  return useQuery<YouTubeResourceSuccess<YouTubeAccountCapabilities>, Error>({
    queryKey: youtubeResourceKey(userId, accountId, "capabilities"),
    queryFn: () => gateway.getCapabilities(accountId as string),
    enabled: Boolean(accountId && user?.id),
    staleTime: YOUTUBE_CAPABILITIES_STALE_MS,
    refetchOnWindowFocus: false,
    retry: youtubeResourceRetry,
  });
}
