// Durable procedure-state transition for one reply turn (PR #209 review, P1 x2).
// Two messages in one conversation can run concurrently -- the outbox owns a message, not
// a conversation -- so the write is a compare-and-set against the value this turn read.
// A lost race or a failed write means this turn's reply no longer matches durable state,
// and the caller must not deliver it.

export interface ProcedureStateDb {
  from(table: "ai_threads"): {
    update(values: { procedure_state: unknown }): ProcedureStateFilter;
  };
}
interface ProcedureStateFilter {
  eq(column: string, value: string): ProcedureStateFilter;
  is(column: string, value: null): ProcedureStateFilter;
  select(columns: "id"): PromiseLike<{ data: unknown[] | null; error: { message: string } | null }>;
}

export const PROCEDURE_STATE_CONFLICT = "procedure_state_conflict";

/** True only when exactly this turn's expected state was replaced. */
export async function persistProcedureState(
  db: ProcedureStateDb,
  threadId: string,
  expected: unknown,
  next: unknown,
): Promise<boolean> {
  const byThread = db.from("ai_threads").update({ procedure_state: next }).eq("id", threadId);
  // jsonb equality is semantic (key order and whitespace do not matter), so the value read
  // at the start of the turn can be sent back as the predicate.
  const guarded = expected === null || expected === undefined
    ? byThread.is("procedure_state", null)
    : byThread.eq("procedure_state", JSON.stringify(expected));
  const { data, error } = await guarded.select("id");
  if (error) {
    console.error("[ai-agent-reply] Procedure state write failed:", error.message);
    return false;
  }
  return (data ?? []).length === 1;
}
