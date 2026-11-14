import { useInfiniteQuery, useMutationState } from "@tanstack/react-query";
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
  const acceptedJobs = useMutationState({
    filters: { mutationKey: ["instagram-insights-sync", userId], status: "success" },
    select: ({ state }) => {
      const variables = state.variables;
      const data = state.data;
      return variables && typeof variables === "object" && "socialAccountId" in variables && variables.socialAccountId === socialAccountId
        && data && typeof data === "object" && "status" in data && data.status === "queued" && "jobId" in data && typeof data.jobId === "string"
        ? data.jobId : null;
    },
  });
  const jobs = acceptedJobs.filter((job) => job !== null);
  const acceptedJob = jobs[jobs.length - 1] ?? null;
  const poll = useRef<{ key: string; acceptedJob: string | null; startedAt: number | null }>({ key: "", acceptedJob: null, startedAt: null });
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
      const collection = query.state.data?.pages[0]?.collection;
      const reason = collection?.reason_code;
      // Cache eviction is not a new acceptance and must not renew an old budget.
      if (poll.current.key !== pollKey || acceptedJob !== null && poll.current.acceptedJob !== acceptedJob) {
        poll.current = { key: pollKey, acceptedJob, startedAt: null };
      }
      const retryAt = Date.parse(collection?.retry_at ?? "");
      const scheduledRetry = ["rate_limited", "provider_error"].includes(reason ?? "") && collection?.reason_source === "job";
      if (!reason || !["queued", "running"].includes(reason) && !scheduledRetry) {
        poll.current.startedAt = null;
        return false;
      }
      poll.current.startedAt ??= Date.now();
      const elapsed = Date.now() - poll.current.startedAt;
      // Read saved job state only, with bounded backoff and a five-minute cap.
      const backoff = Math.min(30_000, 5_000 * 2 ** Math.floor(elapsed / 30_000));
      const retryDelay = scheduledRetry && Number.isFinite(retryAt) ? Math.max(0, retryAt - Date.now()) : 0;
      return elapsed >= 300_000 ? false : Math.min(300_000 - elapsed, 30_000, Math.max(backoff, retryDelay));
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
