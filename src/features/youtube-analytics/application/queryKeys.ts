import type { YouTubeAnalyticsDataOperation, YouTubeAnalyticsPeriodDays } from "../domain/types";

export function youtubeAnalyticsQueryKey(
  userId: string,
  accountId: string,
  connectionRevision: string,
  operation: YouTubeAnalyticsDataOperation,
  windowEnd: string,
  periodDays: YouTubeAnalyticsPeriodDays,
  videoId: string | null = null,
) {
  return [
    "youtube-analytics",
    userId,
    accountId,
    connectionRevision,
    operation,
    windowEnd,
    periodDays,
    videoId,
  ] as const;
}

export function isAccountAnalyticsQueryKey(
  queryKey: readonly unknown[],
  userId: string,
  accountId: string,
  connectionRevision?: string,
): boolean {
  return queryKey[0] === "youtube-analytics"
    && queryKey[1] === userId
    && queryKey[2] === accountId
    && (connectionRevision === undefined || queryKey[3] === connectionRevision);
}
