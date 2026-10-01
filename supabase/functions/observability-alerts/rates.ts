// A rate over a handful of rows is noise: on 2026-10-01 06:06 one failed post among three
// log rows read as a 33% error rate and paged the admin. Each rate rule needs a minimum
// sample before it reports anything.

// Jev triage failures are silent: the reply still goes out, just without the triage plan, so
// a broken tier (a 403 on 2026-09-28, a timeout on 2026-09-30) showed up only as odd replies.
const MIN_TRIAGED_REPLIES = 10;
const MIN_LOGS_FOR_ERROR_RATE = 20;

function sampledPercent(part: number, total: number, minTotal: number): number | null {
  if (total < minTotal) return null;
  return Math.round((part / total) * 100);
}

/** Percent of triaged replies whose triage produced no outcome, or null below the minimum sample. */
export function triageFailurePercent(triaged: number, failed: number): number | null {
  return sampledPercent(failed, triaged, MIN_TRIAGED_REPLIES);
}

/** Percent of system_logs rows at level error, or null below the minimum sample. */
export function errorRatePercent(total: number, errors: number): number | null {
  return sampledPercent(errors, total, MIN_LOGS_FOR_ERROR_RATE);
}
