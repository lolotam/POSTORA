// The durable half of an API refusal: one system_logs row per refusal, so a
// refusal nobody watched still leaves a trace (project rule: every early
// return that refuses work writes a log row).
//
// The row carries the route, the code, the status and the ids only: never the
// request body, never the recipient, never the message text, never a token.
// An account id is written down only when it is a real uuid, because the id
// the caller made up must not reach the log.
import { isValidUuid } from "./requestGuards.ts";

/**
 * Writes the row one refusal leaves behind. It never throws: a refusal that
 * cannot be recorded is still a refusal, the caller gets the same answer, and
 * the edge log is the only sink left when the database refuses the row.
 */
export async function recordApiRefusal(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  request: { userId: string; route: string; code: string; status: number; postId?: string; accountId?: string },
): Promise<void> {
  const { userId, route, code, status, postId, accountId } = request;
  try {
    const { error: insertError } = await supabase
      .from("system_logs")
      .insert({
        source: "n8n-api",
        // The category has to be one the column accepts: system_logs_category_check
        // allows auth, edge, database, token, post, system, ai, scheduler,
        // webhook, payment and media. An "api" row would be rejected by the
        // constraint, so the refusal would leave no durable row at all.
        category: "edge",
        level: "warn",
        message: `${route} refused: ${code}`,
        user_id: userId,
        metadata: {
          route,
          code,
          status,
          ...(postId ? { post_id: postId } : {}),
          ...(accountId && isValidUuid(accountId) ? { account_id: accountId } : {}),
        },
      });
    if (insertError) {
      console.error(
        `[n8n-api] system_logs insert failed while refusing ${route} (${code}, no durable refusal row): ${insertError?.message ?? String(insertError)}`,
      );
    }
  } catch (thrown) {
    // The refusal is still a refusal: the caller gets the same answer, and the
    // edge log is the only sink still reachable.
    const message = thrown instanceof Error ? thrown.message : String(thrown);
    console.error(
      `[n8n-api] system_logs insert failed while refusing ${route} (${code}, no durable refusal row): ${message}`,
    );
  }
}
