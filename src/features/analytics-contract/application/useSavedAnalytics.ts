import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import type { AnalyticsPeriodDays, AnalyticsPlatform } from "../domain/types";
import type { SavedAnalyticsGateway } from "./ports";

export function useSavedAnalytics(input: { gateway: SavedAnalyticsGateway; ownerId: string | null; platform: AnalyticsPlatform;
  selectedAccountId: string | null; periodDays: AnalyticsPeriodDays }) {
  const accounts = useQuery({ queryKey: ["saved-analytics-accounts", input.ownerId, input.platform],
    queryFn: () => input.gateway.accounts(input.ownerId!, input.platform), enabled: !!input.ownerId, retry: false });
  const accountId = accounts.data?.find((account) => account.id === input.selectedAccountId)?.id ?? accounts.data?.[0]?.id ?? null;
  const reports = useInfiniteQuery({ queryKey: ["saved-analytics-report", input.ownerId, input.platform, accountId, input.periodDays],
    initialPageParam: null as string | null,
    queryFn: ({ pageParam }) => input.gateway.report({ platform: input.platform, accountId: accountId!, periodDays: input.periodDays, cursor: pageParam }),
    getNextPageParam: (page) => page.posts.nextCursor ?? undefined,
    enabled: !!input.ownerId && !!accountId && !accounts.isError, retry: false });
  return { accounts, accountId, reports };
}
