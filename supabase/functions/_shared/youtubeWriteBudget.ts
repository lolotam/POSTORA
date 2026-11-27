import { pacificDateString } from "./pacificDay.ts";

export const YOUTUBE_WRITE_BUDGET_DAILY_CEILING = 4000;
export const YOUTUBE_WRITE_BUDGET_WINDOW_SECONDS = 48 * 60 * 60;
export const YOUTUBE_PLAYLIST_INSERT_UNIT_COST = 50;

export type YouTubeWriteBudgetRpc = (
  fn: string,
  params: Record<string, unknown>,
) => Promise<{ data: unknown; error: unknown }>;

export interface WeightedRateLimitDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export type YouTubeWriteBudgetResult =
  | { allowed: true; count: number }
  | { allowed: false; code: "quota_exceeded" | "upstream_unavailable"; retryAfterSeconds?: number };

export function pacificWriteBudgetBucketKey(now: Date): string {
  return `youtube-resources:budget:write:${pacificDateString(now)}`;
}

/**
 * Fail-closed parser for `check_weighted_rate_limit` responses.
 * Returns null on any unexpected shape or non-monotonic count so callers refuse the write.
 */
export function parseWeightedRateLimitDecision(
  raw: unknown,
  requestedCost: number,
): WeightedRateLimitDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") return null;
  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) {
    return null;
  }
  if (
    typeof record.retry_after !== "number" ||
    !Number.isInteger(record.retry_after) ||
    record.retry_after < 0
  ) {
    return null;
  }
  if (record.allowed && (record.count < requestedCost || record.count > YOUTUBE_WRITE_BUDGET_DAILY_CEILING)) {
    return null;
  }
  return {
    allowed: record.allowed,
    count: record.count,
    retryAfterSeconds: record.retry_after,
  };
}

/** Atomically debits `units` from the project-wide Pacific-day YouTube write budget. */
export async function debitYouTubeWriteBudget(input: {
  rpc: YouTubeWriteBudgetRpc;
  units: number;
  now?: Date;
}): Promise<YouTubeWriteBudgetResult> {
  if (!Number.isInteger(input.units) || input.units <= 0) {
    return { allowed: false, code: "upstream_unavailable" };
  }
  const now = input.now ?? new Date();
  try {
    const { data, error } = await input.rpc("check_weighted_rate_limit", {
      p_key: pacificWriteBudgetBucketKey(now),
      p_cost: input.units,
      p_max: YOUTUBE_WRITE_BUDGET_DAILY_CEILING,
      p_window_seconds: YOUTUBE_WRITE_BUDGET_WINDOW_SECONDS,
    });
    if (error) return { allowed: false, code: "upstream_unavailable" };
    const parsed = parseWeightedRateLimitDecision(data, input.units);
    if (!parsed) return { allowed: false, code: "upstream_unavailable" };
    if (!parsed.allowed) {
      return {
        allowed: false,
        code: "quota_exceeded",
        retryAfterSeconds: Math.max(1, parsed.retryAfterSeconds),
      };
    }
    return { allowed: true, count: parsed.count };
  } catch {
    return { allowed: false, code: "upstream_unavailable" };
  }
}
