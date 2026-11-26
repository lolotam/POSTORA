import type { YouTubeAnalyticsErrorCode } from "./contracts.ts";
import { YOUTUBE_ANALYTICS_LIMITS } from "./contracts.ts";
import type { YouTubeAnalyticsRpcRunner } from "./decision.ts";
import { pacificBudgetBucketKey } from "./window.ts";

export type YouTubeAnalyticsLimitResult =
  | { ok: true }
  | { ok: false; code: YouTubeAnalyticsErrorCode; retryAfterSeconds?: number };

interface CounterResult {
  allowed: boolean;
  count: number;
  retryAfterSeconds: number;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

async function callCounter(
  rpc: YouTubeAnalyticsRpcRunner,
  bucket: string,
  identifier: string,
  max: number,
  windowSeconds: number,
): Promise<CounterResult | null> {
  try {
    const { data: raw, error } = await rpc("check_rate_limit", {
      p_endpoint: bucket,
      p_identifier: identifier,
      p_max_requests: max,
      p_window_seconds: windowSeconds,
    });
    const data = record(raw);
    if (error || !data || typeof data.allowed !== "boolean" ||
      typeof data.count !== "number" || !Number.isFinite(data.count) || data.count < 0 ||
      typeof data.retry_after !== "number" || !Number.isFinite(data.retry_after) ||
      data.retry_after < 0) {
      return null;
    }
    return {
      allowed: data.allowed,
      count: data.count,
      retryAfterSeconds: Math.ceil(data.retry_after),
    };
  } catch {
    return null;
  }
}

function counterFailure(
  counter: CounterResult | null,
  code: "rate_limited" | "capacity_reached",
  max: number,
): YouTubeAnalyticsLimitResult {
  if (counter === null) return { ok: false, code: "settings_unavailable" };
  if (!counter.allowed || counter.count > max) {
    return { ok: false, code, retryAfterSeconds: counter.retryAfterSeconds };
  }
  return { ok: true };
}

export async function checkAdmissionLimit(
  rpc: YouTubeAnalyticsRpcRunner,
  userId: string,
): Promise<YouTubeAnalyticsLimitResult> {
  const { max, windowSeconds } = YOUTUBE_ANALYTICS_LIMITS.admission;
  const counter = await callCounter(
    rpc,
    `youtube-analytics:admit:${userId}`,
    userId,
    max,
    windowSeconds,
  );
  return counterFailure(counter, "rate_limited", max);
}

export async function checkDataLimit(
  rpc: YouTubeAnalyticsRpcRunner,
  userId: string,
): Promise<YouTubeAnalyticsLimitResult> {
  const burst = YOUTUBE_ANALYTICS_LIMITS.dataBurst;
  const burstCounter = await callCounter(
    rpc,
    `youtube-analytics:data:10m:${userId}`,
    userId,
    burst.max,
    burst.windowSeconds,
  );
  const burstResult = counterFailure(burstCounter, "rate_limited", burst.max);
  if (!burstResult.ok) return burstResult;
  const daily = YOUTUBE_ANALYTICS_LIMITS.dataDaily;
  const dailyCounter = await callCounter(
    rpc,
    `youtube-analytics:data:24h:${userId}`,
    userId,
    daily.max,
    daily.windowSeconds,
  );
  return counterFailure(dailyCounter, "rate_limited", daily.max);
}

export async function debitSharedBudget(
  rpc: YouTubeAnalyticsRpcRunner,
  kind: "data" | "analytics",
  now: Date,
): Promise<YouTubeAnalyticsLimitResult> {
  const limit = kind === "data"
    ? YOUTUBE_ANALYTICS_LIMITS.sharedData
    : YOUTUBE_ANALYTICS_LIMITS.sharedAnalytics;
  const counter = await callCounter(
    rpc,
    pacificBudgetBucketKey(kind, now),
    "project",
    limit.max,
    limit.windowSeconds,
  );
  if (counter === null) return { ok: false, code: "settings_unavailable" };
  if (!counter.allowed || counter.count > limit.max) {
    return { ok: false, code: "capacity_reached", retryAfterSeconds: counter.retryAfterSeconds };
  }
  if (counter.count < 1) return { ok: false, code: "settings_unavailable" };
  return { ok: true };
}
