// callBudget.ts
/** One absolute deadline shared by every network call of one generation (worker: start + 140 s). */
export interface CallBudget { deadlineMs: number; now(): number; signal(ms: number): AbortSignal }
export class NotEnoughTimeError extends Error {}

export const UNBOUNDED = (now: () => number = Date.now): CallBudget =>
  ({ deadlineMs: Number.POSITIVE_INFINITY, now, signal: (ms) => AbortSignal.timeout(ms) });

export function timeLeftMs(b: CallBudget): number {
  return b.deadlineMs - b.now();
}

export function budgetSignal(b: CallBudget, minMs: number, capMs?: number): AbortSignal | undefined {
  const left = timeLeftMs(b);
  if (left < minMs) throw new NotEnoughTimeError(`not enough time left (${Math.max(0, Math.round(left))} ms) to start this call`);
  const ms = Math.min(capMs ?? Number.POSITIVE_INFINITY, left);
  return Number.isFinite(ms) ? b.signal(ms) : undefined;
}
