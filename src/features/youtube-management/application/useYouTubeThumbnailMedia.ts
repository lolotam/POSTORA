import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { YouTubeThumbnailCandidate } from "../domain/thumbnail";
import type { YouTubeThumbnailMediaGateway } from "./ports";

// The library list changes only when the creator uploads something new, so
// it stays fresh for a minute and never refetches on window focus.
export const YOUTUBE_THUMBNAIL_MEDIA_STALE_MS = 60_000;

/**
 * The creator's own library images, loaded only while the channel may set a
 * thumbnail: an unavailable capability must not spend a database read.
 */
export function useYouTubeThumbnailMedia(options: {
  gateway: YouTubeThumbnailMediaGateway;
  enabled: boolean;
}): UseQueryResult<YouTubeThumbnailCandidate[], Error> {
  const { gateway, enabled } = options;
  const user = useAuth().user;
  const userId = user?.id ?? null;
  return useQuery<YouTubeThumbnailCandidate[], Error>({
    queryKey: ["youtube-resources", userId, "thumbnail-media"] as const,
    queryFn: () => gateway.listOwnedImages({ userId: userId as string }),
    enabled: Boolean(enabled && userId),
    staleTime: YOUTUBE_THUMBNAIL_MEDIA_STALE_MS,
    refetchOnWindowFocus: false,
    retry: false,
  });
}
