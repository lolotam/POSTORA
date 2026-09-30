// Jev triage failures are silent: the reply still goes out, just without the triage plan, so
// a broken tier (a 403 on 2026-09-28, a timeout on 2026-09-30) showed up only as odd replies.
// A handful of replies is too few to call a rate, so small samples never alert.
const MIN_TRIAGED_REPLIES = 10;

/** One ai-agent-reply system_logs row, reduced to its `metadata.triage` JSON (null when triage is off). */
export interface TriageLogRow {
  triage: unknown;
}

/** Percent of triaged replies whose triage produced no outcome, or null below the minimum sample. */
export function triageFailurePercent(rows: TriageLogRow[]): number | null {
  const triaged = rows
    .map((row) => row.triage)
    .filter((triage): triage is { outcome?: unknown } => triage !== null && typeof triage === "object");
  if (triaged.length < MIN_TRIAGED_REPLIES) return null;
  const failed = triaged.filter((triage) => triage.outcome == null).length;
  return Math.round((failed / triaged.length) * 100);
}
