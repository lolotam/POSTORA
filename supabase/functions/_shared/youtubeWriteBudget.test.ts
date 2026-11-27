import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  debitYouTubeWriteBudget,
  pacificWriteBudgetBucketKey,
  parseWeightedRateLimitDecision,
  YOUTUBE_PLAYLIST_INSERT_UNIT_COST,
  YOUTUBE_WRITE_BUDGET_DAILY_CEILING,
  YOUTUBE_WRITE_BUDGET_WINDOW_SECONDS,
} from "./youtubeWriteBudget.ts";

Deno.test("debitYouTubeWriteBudget calls check_weighted_rate_limit with 50 units and Pacific-day bucket key", async () => {
  const calls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const now = new Date("2026-11-27T06:00:00Z"); // 2026-11-26 22:00 PST
  const result = await debitYouTubeWriteBudget({
    rpc: (fn, params) => {
      calls.push({ fn, params });
      return Promise.resolve({ data: { allowed: true, count: 50, retry_after: 0 }, error: null });
    },
    units: YOUTUBE_PLAYLIST_INSERT_UNIT_COST,
    now,
  });

  assertEquals(result, { allowed: true, count: 50 });
  assertEquals(calls, [{
    fn: "check_weighted_rate_limit",
    params: {
      p_key: pacificWriteBudgetBucketKey(now),
      p_cost: 50,
      p_max: YOUTUBE_WRITE_BUDGET_DAILY_CEILING,
      p_window_seconds: YOUTUBE_WRITE_BUDGET_WINDOW_SECONDS,
    },
  }]);
  assertEquals(pacificWriteBudgetBucketKey(now), "youtube-resources:budget:write:2026-11-26");
});

Deno.test("debitYouTubeWriteBudget returns quota_exceeded when refused", async () => {
  const result = await debitYouTubeWriteBudget({
    rpc: () => Promise.resolve({ data: { allowed: false, count: 3980, retry_after: 0 }, error: null }),
    units: 50,
    now: new Date("2026-11-27T12:00:00Z"),
  });
  assertEquals(result, { allowed: false, code: "quota_exceeded", retryAfterSeconds: 1 });
});

Deno.test("debitYouTubeWriteBudget fails closed as upstream_unavailable on error, throw, or malformed payload", async () => {
  const badOutcomes: Array<() => Promise<{ data: unknown; error: unknown }>> = [
    () => Promise.resolve({ data: null, error: { message: "db down" } }),
    () => Promise.reject(new Error("network")),
    () => Promise.resolve({ data: null, error: null }),
    () => Promise.resolve({ data: [], error: null }),
    () => Promise.resolve({ data: { allowed: "yes", count: 50, retry_after: 0 }, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 49, retry_after: 0 }, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 4001, retry_after: 0 }, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 50.5, retry_after: 0 }, error: null }),
    () => Promise.resolve({ data: { allowed: true, count: 50, retry_after: -1 }, error: null }),
  ];

  for (const rpc of badOutcomes) {
    const result = await debitYouTubeWriteBudget({ rpc, units: 50 });
    assertEquals(result, { allowed: false, code: "upstream_unavailable" });
  }
});

Deno.test("parseWeightedRateLimitDecision validates boundary counts", () => {
  assertEquals(parseWeightedRateLimitDecision({ allowed: true, count: 50, retry_after: 0 }, 50), {
    allowed: true,
    count: 50,
    retryAfterSeconds: 0,
  });
  assertEquals(parseWeightedRateLimitDecision({ allowed: true, count: 4000, retry_after: 0 }, 50), {
    allowed: true,
    count: 4000,
    retryAfterSeconds: 0,
  });
  assertEquals(parseWeightedRateLimitDecision({ allowed: true, count: 49, retry_after: 0 }, 50), null);
});
