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

/**
 * Which call holds a slot. The holder is a token, not a flag, so a call that
 * settles late (after `resetAnonymousSlots`, or after a newer holder took the
 * slot) can only free its own hold, never somebody else's.
 */
const anonymousSlots = new Map<AnonymousSlotName, symbol>();

/** Forget every slot: a fresh worker (test seam). */
export function resetAnonymousSlots(): void {
  anonymousSlots.clear();
}

/** Whether a slot currently has an in-flight call. */
export function isAnonymousSlotBusy(name: AnonymousSlotName): boolean {
  return anonymousSlots.has(name);
}

/**
 * How one anonymous call ended, as far as the request that started it can tell.
 *   busy     another call holds the slot: nothing was started
 *   bound    ANON_PROBE_TIMEOUT_MS passed and the call is STILL running
 *   failed   the call settled by rejecting
 *   settled  the call settled with `value`
 */
export type AnonymousCall<T> =
  | { kind: "busy" }
  | { kind: "bound" }
  | { kind: "failed" }
  | { kind: "settled"; value: T };

/**
 * Run one anonymous database call in its slot and wait for it at most
 * ANON_PROBE_TIMEOUT_MS. `start` is called only when the slot was free. The
 * call keeps running when the bound passes, and the slot is freed by the call
 * settling, never by the bound. `onSettled` observes the actual outcome even
 * when the caller stopped waiting at the bound.
 */
export async function runInAnonymousSlot<T>(
  name: AnonymousSlotName,
  start: () => PromiseLike<T>,
  onSettled?: (outcome: AnonymousCall<T>) => void,
): Promise<AnonymousCall<T>> {
  if (anonymousSlots.has(name)) return { kind: "busy" };
  const token = Symbol(name);
  anonymousSlots.set(name, token);

  let call: Promise<AnonymousCall<T>>;
  try {
    call = Promise.resolve(start()).then(
      (value) => ({ kind: "settled" as const, value }),
      () => ({ kind: "failed" as const }),
    );
  } catch {
    call = Promise.resolve({ kind: "failed" as const });
  }
  // Attached before the race below, so the slot is already free when the
  // request that waited for this call carries on.
  call.then((outcome) => {
    if (anonymousSlots.get(name) === token) anonymousSlots.delete(name);
    try {
      onSettled?.(outcome);
    } catch {
      // A settlement observer must never turn a slot release into an unhandled rejection.
    }
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<AnonymousCall<T>>((resolve) => {
    timer = setTimeout(() => resolve({ kind: "bound" }), ANON_PROBE_TIMEOUT_MS);
  });
  try {
    return await Promise.race([call, bound]);
  } finally {
    clearTimeout(timer);
  }
}
