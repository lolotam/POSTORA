/**
 * How long the cron sweep may keep starting work.
 *
 * The edge worker is killed at 60s. This leaves ~15s of that to persist results and log
 * after the last account finishes.
 */
export const SWEEP_BUDGET_MS = 45_000;

/**
 * Worst case for a single account: the provider exchange, then the avatar fetch and the
 * avatar upload, each bounded at 8s by its own AbortSignal.
 */
export const ACCOUNT_WORST_CASE_MS = 24_000;

/**
 * Whether one more account can be started.
 *
 * The question is whether the worst case for that account still fits, NOT whether the
 * budget is already spent. Comparing elapsed time alone let the sweep start an account at
 * 44.9s that could then run for 24s — 68.9s against the 60s ceiling, killed mid-write. A
 * bound that can be exceeded by 24s is not a bound.
 */
export function mayStartAnotherAccount(elapsedMs: number): boolean {
  return elapsedMs <= SWEEP_BUDGET_MS - ACCOUNT_WORST_CASE_MS;
}
