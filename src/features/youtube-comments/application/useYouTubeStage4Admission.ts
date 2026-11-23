import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { YouTubeCommentsGateway } from "./ports";
import { youtubeCommentsKey, YOUTUBE_COMMENTS_STALE_MS } from "./queryKeys";

export type YouTubeStage4Admission = "loading" | "admitted" | "legacy";

/**
 * Should the existing YouTube inbox mount the Stage 4 surface for this
 * account? Only a server answer of `read` admits it: a Composio connection,
 * a gate-off account, an old backend ("Unknown action") and a transport
 * failure all keep the baseline inbox exactly as it is (spec 4, 13).
 *
 * The gateway is injected: the application layer never imports the
 * infrastructure default (ARCHITECTURE 4).
 */
export function useYouTubeStage4Admission(
  accountId: string | null,
  enabled: boolean,
  gateway: YouTubeCommentsGateway,
): YouTubeStage4Admission {
  const { session } = useAuth();
  const userId = session?.user?.id ?? "";
  const query = useQuery({
    queryKey: youtubeCommentsKey(userId, accountId, "admission"),
    queryFn: () => gateway.capabilities(accountId!),
    enabled: enabled && !!accountId && !!userId,
    staleTime: YOUTUBE_COMMENTS_STALE_MS,
    retry: false,
  });
  if (!enabled || !accountId) return "legacy";
  if (query.isLoading) return "loading";
  if (query.isError) return "legacy";
  return query.data?.capabilities?.read?.allowed === true ? "admitted" : "legacy";
}
