import {
  debitYouTubeWriteBudget,
  type YouTubeWriteBudgetRpc,
} from "../_shared/youtubeWriteBudget.ts";
import {
  checkCaptionUploadCounter,
  checkSingleCounter,
  parseStrictRateLimitDecision,
  type StrictRateLimitDecision,
   type WriteCounterResult,
  YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT,
  YOUTUBE_CAPTION_UPLOAD_UNIT_COST,
} from "../_shared/youtubeWriteCounters.ts";

export {
  checkCaptionUploadCounter,
  checkSingleCounter,
  parseStrictRateLimitDecision,
  type StrictRateLimitDecision,
  type WriteCounterResult,
  YOUTUBE_CAPTION_UPLOAD_DAILY_LIMIT,
  YOUTUBE_CAPTION_UPLOAD_UNIT_COST,
};

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

export const YOUTUBE_CAPTION_LIST_DAILY_LIMIT = {
  keyPrefix: "youtube-resources:caption-list:day",
  limit: 10,
  windowSeconds: 86400,
} as const;

export const YOUTUBE_CAPTION_LIST_UNIT_COST = 50;

export type WriteBudgetDebitResult =
  | { ok: true; count: number }
  | { ok: false; code: "quota_exceeded" | "upstream_unavailable"; retryAfterSeconds?: number };

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

/** Checks the per-user daily caption list counter (10 lists / 24 h), failing closed. */
export async function checkCaptionListCounter(input: {
  rpc: YouTubeWriteBudgetRpc;
  userId: string;
}): Promise<WriteCounterResult> {
  return await checkSingleCounter(
    input.rpc,
    YOUTUBE_CAPTION_LIST_DAILY_LIMIT.keyPrefix,
    input.userId,
    YOUTUBE_CAPTION_LIST_DAILY_LIMIT.limit,
    YOUTUBE_CAPTION_LIST_DAILY_LIMIT.windowSeconds,
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
