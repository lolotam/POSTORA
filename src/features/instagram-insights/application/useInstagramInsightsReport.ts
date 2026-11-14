import { useInfiniteQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useAuth } from "@/hooks/useAuth";
import type { OwnerReport, OwnerReportCursor, OwnerReportPeriodDays } from "../domain/types";
import type { InstagramInsightsGateway } from "./ports";

export type UseInstagramInsightsReportOptions = {
  gateway: InstagramInsightsGateway;
  socialAccountId: string | null;
  periodDays: OwnerReportPeriodDays;
  cursor?: OwnerReportCursor | null;
  limit?: number;
  enabled?: boolean;
};

export function useInstagramInsightsReport({
  gateway,
  socialAccountId,
  periodDays,
  cursor = null,
  limit = 20,
  enabled = true,
}: UseInstagramInsightsReportOptions) {
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";
  const poll = useRef<{ key: string; startedAt: number | null }>({ key: "", startedAt: null });
  const pollKey = JSON.stringify([userId, socialAccountId, periodDays]);

  return useInfiniteQuery({
    queryKey: ["instagram-insights-report", userId, socialAccountId, periodDays, cursor, limit],
    initialPageParam: cursor,
    queryFn: async ({ pageParam }): Promise<OwnerReport> => {
      if (!socialAccountId) {
        throw new Error("Social account ID is required");
      }
      return gateway.getReport({
        socialAccountId,
        periodDays,
        cursor: pageParam,
        limit,
      });
    },
    getNextPageParam: (lastPage) => lastPage.media.page.hasMore
      ? lastPage.media.page.nextCursor ?? undefined
      : undefined,
    enabled: Boolean(enabled && socialAccountId && user?.id),
    staleTime: 60_000,
    refetchInterval: (query) => {
      const reason = query.state.data?.pages[0]?.collection?.reason_code;
      if (poll.current.key !== pollKey) poll.current = { key: pollKey, startedAt: null };
      if (!reason || !["queued", "running"].includes(reason)) {
        poll.current.startedAt = null;
        return false;
      }
      poll.current.startedAt ??= Date.now();
      const elapsed = Date.now() - poll.current.startedAt;
      // Read saved job state only, with bounded backoff and a five-minute cap.
      return elapsed >= 300_000 ? false : Math.min(30_000, 5_000 * 2 ** Math.floor(elapsed / 30_000));
    },
    retry: (failureCount, error) => {
      // Don't retry on client 400 or cross-owner 404 errors
      if (error.message.includes("404") || error.message.includes("400") || error.message.includes("MISMATCH")) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
