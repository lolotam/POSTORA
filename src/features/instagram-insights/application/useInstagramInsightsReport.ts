import { useQuery } from "@tanstack/react-query";
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

  return useQuery<OwnerReport, Error>({
    queryKey: ["instagram-insights-report", userId, socialAccountId, periodDays, cursor, limit],
    queryFn: async () => {
      if (!socialAccountId) {
        throw new Error("Social account ID is required");
      }
      return gateway.getReport({
        socialAccountId,
        periodDays,
        cursor,
        limit,
      });
    },
    enabled: Boolean(enabled && socialAccountId && user?.id),
    staleTime: 60_000,
    retry: (failureCount, error) => {
      // Don't retry on client 400 or cross-owner 404 errors
      if (error.message.includes("404") || error.message.includes("400") || error.message.includes("MISMATCH")) {
        return false;
      }
      return failureCount < 2;
    },
  });
}
