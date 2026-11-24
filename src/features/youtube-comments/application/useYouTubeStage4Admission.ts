import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { YouTubeCommentsError } from "../domain/errors";
import { YouTubeCommentsGateway } from "./ports";
import { youtubeCommentsKey, YOUTUBE_COMMENTS_STALE_MS } from "./queryKeys";

/**
 * `unavailable` is a settings read that FAILED (the server's 503 `upstream`,
 * with nothing cached to go on): it is neither "admitted" nor a denial, so the
 * panel shows it with a retry instead of silently picking the baseline inbox.
 */
export type YouTubeStage4Admission = "loading" | "admitted" | "legacy" | "unavailable";

export interface YouTubeStage4AdmissionState {
  admission: YouTubeStage4Admission;
  /** Asks the server again; used by the retry offered for `unavailable`. */
  retry: () => void;
}

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
): YouTubeStage4AdmissionState {
  const { session } = useAuth();
  const userId = session?.user?.id ?? "";
  const query = useQuery({
    queryKey: youtubeCommentsKey(userId, accountId, "admission"),
    queryFn: () => gateway.capabilities(accountId!),
    enabled: enabled && !!accountId && !!userId,
    staleTime: YOUTUBE_COMMENTS_STALE_MS,
    retry: false,
  });
  const retry = () => void query.refetch();
  const state = (admission: YouTubeStage4Admission): YouTubeStage4AdmissionState => ({ admission, retry });
  if (!enabled || !accountId) return state("legacy");
  if (query.isLoading) return state("loading");
  // The data decides when there is any. A background refetch that fails keeps
  // the earlier data AND sets the error state, so reading the error first would
  // unmount an admitted screen mid-use (possibly while the owner is typing).
  // Only an error with no data at all means the baseline inbox.
  if (query.data !== undefined) return state(query.data.capabilities?.read?.allowed === true ? "admitted" : "legacy");
  // No answer at all. A failed settings read (503 upstream) is shown as such; every other failure
  // (an old backend, a transport error without a reason) keeps the baseline inbox exactly as it was.
  if (query.error instanceof YouTubeCommentsError && query.error.code === "upstream") return state("unavailable");
  return state("legacy");
}
