/**
 * How often a refused (unsigned or forged) webhook delivery is written to system_logs.
 *
 * Anyone who knows the URL can send refusals, so writing one row per request would let them
 * fill the table. A worker writes at most one row per window and counts the rest into it; the
 * console still sees every refusal. Real Resend deliveries that stop verifying (a rotated
 * secret) are retried by Svix, so they keep producing a row every window.
 */

/** Short enough to fire within an edge worker's lifetime, so held-back counts reach the table. */
export const REFUSAL_LOG_WINDOW_MS = 60 * 1000;

export interface RefusalLogGate {
  /** Whether this refusal gets a row, and how many earlier ones in this worker it stands for. */
  admit(nowMs?: number): { write: true; suppressed: number } | { write: false };
}

export function createRefusalLogGate(windowMs = REFUSAL_LOG_WINDOW_MS): RefusalLogGate {
  let lastWriteMs: number | null = null;
  let suppressed = 0;
  return {
    admit(nowMs = Date.now()) {
      if (lastWriteMs !== null && nowMs - lastWriteMs < windowMs) {
        suppressed++;
        return { write: false };
      }
      const counted = suppressed;
      lastWriteMs = nowMs;
      suppressed = 0;
      return { write: true, suppressed: counted };
    },
  };
}
