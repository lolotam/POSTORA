// Jev triage failures are silent: the reply still goes out, just without the triage plan, so
// a broken tier (a 403 on 2026-09-28, a timeout on 2026-09-30) showed up only as odd replies.
// A handful of replies is too few to call a rate, so small samples never alert.
const MIN_TRIAGED_REPLIES = 10;

/** Percent of triaged replies whose triage produced no outcome, or null below the minimum sample. */
export function triageFailurePercent(triaged: number, failed: number): number | null {
  if (triaged < MIN_TRIAGED_REPLIES) return null;
  return Math.round((failed / triaged) * 100);
}
