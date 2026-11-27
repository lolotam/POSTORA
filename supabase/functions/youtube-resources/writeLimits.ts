import {
  debitYouTubeWriteBudget,
  type YouTubeWriteBudgetRpc,
} from "../_shared/youtubeWriteBudget.ts";

export const YOUTUBE_EDIT_BURST_LIMIT = {
  keyPrefix: "youtube-resources:edit:burst",
  limit: 10,
  windowSeconds: 600,
} as const;

export const YOUTUBE_EDIT_DAILY_LIMIT = {
  keyPrefix: "youtube-resources:edit:day",
  limit: 50,
  windowSeconds: 86400,
} as const;

export const YOUTUBE_THUMBNAIL_SET_UNIT_COST = 50;

export interface StrictRateLimitDecision {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

export type WriteCounterResult =
  | { ok: true }
  | { ok: false; code: "rate_limited" | "upstream_unavailable"; retryAfterSeconds?: number };

export type WriteBudgetDebitResult =
  | { ok: true; count: number }
  | { ok: false; code: "quota_exceeded" | "upstream_unavailable"; retryAfterSeconds?: number };

/**
 * Fail-closed parser for `check_rate_limit` responses (Spec §4.3).
 * Returns null on any unexpected shape or out-of-range count so callers refuse the write.
 */
export function parseStrictRateLimitDecision(
  raw: unknown,
  max: number,
): StrictRateLimitDecision | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.allowed !== "boolean") return null;
  if (typeof record.count !== "number" || !Number.isInteger(record.count) || record.count < 0) {
    return null;
  }
  const rawRetryAfter = record.retry_after !== undefined ? record.retry_after : record.retryAfter;
  if (typeof rawRetryAfter !== "number" || !Number.isInteger(rawRetryAfter) || rawRetryAfter < 0) {
    return null;
  }
  if (record.allowed && (record.count < 1 || record.count > max)) {
    return null;
  }
  return {
    allowed: record.allowed,
    count: record.count,
    retryAfterSeconds: rawRetryAfter,
  };
}

async function checkSingleCounter(
  rpc: YouTubeWriteBudgetRpc,
  endpoint: string,
  userId: string,
  limit: number,
  windowSeconds: number,
): Promise<WriteCounterResult> {
  try {
    const { data, error } = await rpc("check_rate_limit", {
      p_endpoint: endpoint,
      p_identifier: `user:${userId}`,
      p_max_requests: limit,
      p_window_seconds: windowSeconds,
    });
    if (error) return { ok: false, code: "upstream_unavailable" };
    const decision = parseStrictRateLimitDecision(data, limit);
    if (!decision) return { ok: false, code: "upstream_unavailable" };
    if (!decision.allowed) {
      return {
        ok: false,
        code: "rate_limited",
        retryAfterSeconds: Math.max(1, decision.retryAfterSeconds),
      };
    }
    return { ok: true };
  } catch {
    return { ok: false, code: "upstream_unavailable" };
  }
}

/**
 * Checks per-user burst and daily write counters in order, failing closed if
 * either counter is refused, errored, or malformed.
 */
export async function checkUserWriteCounters(input: {
  rpc: YouTubeWriteBudgetRpc;
  userId: string;
}): Promise<WriteCounterResult> {
  const burst = await checkSingleCounter(
    input.rpc,
    YOUTUBE_EDIT_BURST_LIMIT.keyPrefix,
    input.userId,
    YOUTUBE_EDIT_BURST_LIMIT.limit,
    YOUTUBE_EDIT_BURST_LIMIT.windowSeconds,
  );
  if (!burst.ok) return burst;

  return await checkSingleCounter(
    input.rpc,
    YOUTUBE_EDIT_DAILY_LIMIT.keyPrefix,
    input.userId,
    YOUTUBE_EDIT_DAILY_LIMIT.limit,
    YOUTUBE_EDIT_DAILY_LIMIT.windowSeconds,
  );
}

/**
 * Atomically debits `units` from the project-wide Pacific-day YouTube write budget.
 */
export async function debitWriteBudget(input: {
  rpc: YouTubeWriteBudgetRpc;
  units: number;
  now?: Date;
}): Promise<WriteBudgetDebitResult> {
  const result = await debitYouTubeWriteBudget(input);
  if (result.allowed) {
    return { ok: true, count: result.count };
  }
  return {
    ok: false,
    code: result.code,
    ...(result.retryAfterSeconds !== undefined ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
  };
}
