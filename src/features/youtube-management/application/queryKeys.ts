import { isRetryableYouTubeError, YouTubeResourceError } from "../domain/errors";

export const YOUTUBE_RESOURCE_STALE_MS = 5 * 60_000;
export const YOUTUBE_CAPABILITIES_STALE_MS = 60_000;

export function youtubeResourceKey(userId: string, accountId: string | null, resource: string, id?: string) {
  return ["youtube-resources", userId, accountId, resource, id ?? null] as const;
}

// One repeat, and only for transient failures. Quota and rate limit are never retried.
export function youtubeResourceRetry(failureCount: number, error: unknown): boolean {
  return failureCount < 1 && error instanceof YouTubeResourceError && isRetryableYouTubeError(error.code);
}
