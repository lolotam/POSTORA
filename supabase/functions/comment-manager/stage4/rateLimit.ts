// Fail-closed rate limiting for Stage 4.
//
// The shared `_shared/rate-limiter.ts` fails OPEN (an RPC error returns
// `allowed: true`). Stage 4 writes can duplicate public comments, so the
// limiter must fail CLOSED. This module calls the same `check_rate_limit`
// RPC but treats any error or missing result as a denial.
//
// The bucket key is `stage4:<action>:<user_id>` so a user's reads and writes
// are capped independently per action.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";

export interface Stage4RateLimitResult {
  allowed: boolean;
  remaining: number;
  retryAfter: number;
}

export async function stage4RateLimit(
  admin: SupabaseClient,
  userId: string,
  action: string,
  maxRequests: number,
  windowSeconds: number,
): Promise<Stage4RateLimitResult> {
  const bucketKey = `stage4:${action}:${userId}`;
  try {
    const { data, error } = await admin.rpc("check_rate_limit", {
      p_endpoint: bucketKey,
      p_identifier: userId,
      p_max_requests: maxRequests,
      p_window_seconds: windowSeconds,
    });
    if (error || !data) {
      return { allowed: false, remaining: 0, retryAfter: windowSeconds };
    }
    const allowed = data.allowed === true;
    const remaining = typeof data.remaining === "number" ? data.remaining : 0;
    const retryAfter = typeof data.retry_after === "number" ? data.retry_after : 0;
    return { allowed, remaining, retryAfter };
  } catch {
    return { allowed: false, remaining: 0, retryAfter: windowSeconds };
  }
}

export const STAGE4_RATE_LIMITS = {
  read: { max: 120, windowSeconds: 60 },
  write: { max: 20, windowSeconds: 60 },
  ban: { max: 5, windowSeconds: 86400 },
} as const;
