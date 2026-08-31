import type { ConnectorResult } from "./types.ts";

// Bookkeeping for the test_connection probe: the ADAPTER writes
// last_test_at / last_test_ok / last_test_error (migration
// 20260831130000 §C), not the browser — it already runs under the service
// role and already holds the tool row and the outcome, where a browser-driven
// write would be a second round trip that can fail independently and leave
// the badge disagreeing with the row.
//
// The seam is loosely typed on purpose, in the register of handler.ts's
// AdminClientFactory: a structural type narrow enough to be useful would have
// to restate supabase-js's builder and would then drift from it.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type TestOutcomeAdmin = { from(table: string): any };

function failureText(outcome: Extract<ConnectorResult, { ok: false }>): string {
  return `${outcome.error.code}: ${outcome.error.message}`;
}

/**
 * Records one probe outcome on the tool row. NEVER rejects: the outcome the
 * caller already holds is the answer the user sees, and a failed bookkeeping
 * update must not repaint a successful probe as a failure (or vice versa).
 */
export async function persistConnectionTestOutcome(
  admin: TestOutcomeAdmin,
  toolId: string,
  outcome: ConnectorResult,
): Promise<void> {
  try {
    const { error } = await admin
      .from("ai_agent_tools")
      .update({
        last_test_at: new Date().toISOString(),
        last_test_ok: outcome.ok,
        last_test_error: outcome.ok ? null : failureText(outcome),
      })
      .eq("id", toolId);
    if (error) throw error;
  } catch {
    console.warn(
      JSON.stringify({
        event: "connector_failure",
        error_code: "test_result_persist_failed",
        tool_id: toolId,
      }),
    );
  }
}
