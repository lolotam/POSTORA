export const YOUTUBE_COMMENTS_STALE_MS = 60_000;

export function youtubeCommentsKey(userId: string, accountId: string | null, resource: string, id?: string) {
  return ["youtube-comments", userId, accountId, resource, id ?? null] as const;
}
