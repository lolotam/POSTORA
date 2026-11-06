export interface RetryRequest {
  requestedAt: string;
  accountIds: string[];
  platforms: string[];
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((entry) => typeof entry === "string" && entry.length > 0);
}

/** Only the marker belonging to this request may narrow targets or enable retry recovery. */
export function activeRetryRequest(post: {
  publish_requested_at?: string | null;
  metadata?: unknown;
}): RetryRequest | null {
  const marker = record(record(post.metadata)?.retry_request);
  if (!marker || typeof marker.requested_at !== "string" ||
    typeof post.publish_requested_at !== "string") return null;
  const requestedAt = Date.parse(marker.requested_at);
  if (!Number.isFinite(requestedAt) || requestedAt !== Date.parse(post.publish_requested_at) ||
    !nonEmptyStrings(marker.account_ids) || !nonEmptyStrings(marker.platforms)) return null;
  return { requestedAt: marker.requested_at, accountIds: marker.account_ids, platforms: marker.platforms };
}
