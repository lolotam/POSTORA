import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTikTokConnectionGateway } from "./connectionPort";
import { tiktokReviewKeys } from "./useTikTokReview";

/** Connect (redirects the browser to TikTok) and disconnect a TikTok account. */
export function useTikTokConnection() {
  const gateway = useTikTokConnectionGateway();
  const client = useQueryClient();

  const connect = useMutation({
    mutationFn: () => gateway.authorizeUrl(),
    onSuccess: (url) => {
      window.location.assign(url);
    },
  });

  const disconnect = useMutation({
    mutationFn: (accountId: string) => gateway.disconnect(accountId),
    onSuccess: () => client.invalidateQueries({ queryKey: tiktokReviewKeys.accounts }),
  });

  return { connect, disconnect };
}
