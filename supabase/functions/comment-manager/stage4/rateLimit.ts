// Fail-closed rate limiting for Stage 4.
//
// The shared `_shared/rate-limiter.ts` fails OPEN (an RPC error returns
// `allowed: true`). Stage 4 writes can duplicate public comments, so the
// limiter must fail CLOSED. This module calls the same `check_rate_limit`
// RPC but treats any error or missing result as a denial.
//
// The bucket key is `stage4:<action>:<user_id>` so a user's reads and writes
// are capped independently per action.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

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

// ---------------------------------------------------------------------------
// The anonymous refusal gate.
//
// Every anonymous database call this worker makes holds its OWN slot. The
// slot is taken when the call starts and freed when the CALL settles, never
// by the timeout: a call that outlives the bound keeps its slot, so this
// worker cannot put a second call on the same row while the first is still
// running. A request that finds a slot taken never waits on that call and
// never starts a second one.
//
// A call that never settles therefore keeps its slot for the lifetime of the
// worker. That is the fail-closed outcome: the worker stops calling the
// database, and every refusal it still answers keeps its console event.
//
// The bound is a LOCAL one: it limits how long a request waits, nothing
// else. The database is never aborted, because aborting would release the
// slot at the bound and let a second call start while the first is still
// running on the server.
// ---------------------------------------------------------------------------

/** How long a request waits for one anonymous database call. */
export const ANON_PROBE_TIMEOUT_MS = 1_500;

/** The anonymous calls that each hold their own slot. */
export type AnonymousSlotName =
  | "bucket_probe"
  | "counter_probe"
  | "counter_insert"
  | "audit_insert";

const anonymousSlots = new Set<AnonymousSlotName>();

/** Take the slot. False when another call still holds it. */
export function takeAnonymousSlot(name: AnonymousSlotName): boolean {
  if (anonymousSlots.has(name)) return false;
  anonymousSlots.add(name);
  return true;
}

/** Free the slot: called when the call settles, whenever that is. */
export function releaseAnonymousSlot(name: AnonymousSlotName): void {
  anonymousSlots.delete(name);
}

/** Forget every slot: a fresh worker (test seam). */
export function resetAnonymousSlots(): void {
  anonymousSlots.clear();
}

/**
 * Wait for `call` at most ANON_PROBE_TIMEOUT_MS.
 *
 * The call keeps running when the bound passes. `release` is called when it
 * settles, so a slot held by a hung call is freed by the call itself and
 * never by the timeout. `timedOut` says the bound passed before the call
 * settled; `error` carries the failure of a call that settled in time.
 */
export async function withAnonymousBound<T>(
  call: PromiseLike<T>,
  release: () => void,
): Promise<{ timedOut: boolean; value: T | null; error: unknown | null }> {
  let settled = false;
  let value: T | null = null;
  let error: unknown = null;
  const observed = Promise.resolve(call).then(
    (v) => { settled = true; value = v; release(); return v; },
    (e) => { settled = true; error = e; release(); throw e; },
  );
  // The race observes the rejection, so it is never an unhandled rejection:
  // the caller reads the timeout and the failure as one answer.
  const raced = observed.then(() => "settled" as const, () => "settled" as const);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<"bound">((resolve) => {
    timer = setTimeout(() => resolve("bound"), ANON_PROBE_TIMEOUT_MS);
  });
  try {
    await Promise.race([raced, bound]);
  } finally {
    clearTimeout(timer);
  }
  return { timedOut: !settled, value, error };
}
