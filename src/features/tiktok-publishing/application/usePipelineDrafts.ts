import { useQueries } from "@tanstack/react-query";
import type { ReviewDraft, ReviewState, TikTokAccount } from "../domain/types";
import { useTikTokReviewGateway } from "./ports";
import { tiktokReviewKeys, useTikTokAccounts } from "./useTikTokReview";

export interface PipelineDrafts {
  accounts: TikTokAccount[];
  drafts: ReviewDraft[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

/**
 * Every draft in the given states across every connected TikTok account, newest first.
 * The tiktok-review contract lists one (account, state) pair per call, so this fans out
 * and shares the cache keys the single-list hooks already use.
 */
export function usePipelineDrafts(states: readonly ReviewState[]): PipelineDrafts {
  const gateway = useTikTokReviewGateway();
  const accountsQuery = useTikTokAccounts();
  const accounts = accountsQuery.data ?? [];

  const pairs = accounts.flatMap((account) => states.map((state) => ({ accountId: account.id, state })));
  const lists = useQueries({
    queries: pairs.map(({ accountId, state }) => ({
      queryKey: tiktokReviewKeys.list(accountId, state),
      queryFn: () => gateway.list(accountId, state),
    })),
  });

  const drafts = lists
    .flatMap((query) => query.data ?? [])
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const failed = lists.find((query) => query.isError);

  return {
    accounts,
    drafts,
    isPending: accountsQuery.isPending || lists.some((query) => query.isPending),
    isError: accountsQuery.isError || !!failed,
    error: accountsQuery.error ?? failed?.error ?? null,
    refetch: () => {
      void accountsQuery.refetch();
      lists.forEach((query) => { void query.refetch(); });
    },
  };
}
