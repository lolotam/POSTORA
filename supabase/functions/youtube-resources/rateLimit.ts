export interface YouTubeRateLimitDecision {
  allowed: boolean;
  retryAfterSeconds: number;
}

// `result` is what checkUserRateLimit resolved with. It is read as unknown because the database
// answers `retry_after` while the TypeScript type says `retryAfter`.
export function toRateLimitDecision(result: unknown, windowSeconds: number): YouTubeRateLimitDecision {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return { allowed: true, retryAfterSeconds: 0 };
  }
  const record = result as Record<string, unknown>;
  if (record.allowed !== false) return { allowed: true, retryAfterSeconds: 0 };
  const wait = [record.retry_after, record.retryAfter].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value) && value > 0,
  );
  return { allowed: false, retryAfterSeconds: wait ?? windowSeconds };
}
