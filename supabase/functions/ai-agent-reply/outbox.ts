// How ai-agent-reply moves an outbox row through the states that matter to delivery.
//
// A sibling of index.ts rather than part of it because index.ts is a Deno.serve module --
// importing it starts a server -- and these three functions are the ones whose ORDER is the
// safety argument. They are tested with a stub that refuses a transition from the wrong
// state, exactly as advance_agent_reply does.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md, Task 4.

import { advanceReply } from "../_shared/pendingReplies.ts";

export type OutboxEntry =
  /**
   * Text from an earlier attempt is durable; deliver it and touch nothing else. `toolCalls`
   * is what the ORIGINAL generation ran, carried so the thread row a redelivery writes says
   * where the answer came from instead of claiming it came from nowhere.
   */
  | { mode: "redeliver"; text: string; toolCalls: unknown[] | null }
  /** Fresh work, now owned by this invocation. Generation may begin. */
  | { mode: "generate" }
  /** Not ours to run. `status` says why, for the log. */
  | { mode: "refuse"; status: string };

/**
 * Decides what this invocation may do with the row, and takes ownership if it may generate.
 *
 * `pending -> running` is a confirmed transition, made BEFORE the model chain and the tool
 * loop. That is what makes a later kill classifiable: a row found lapsed in `running` may
 * have fired a tool, and recovery hands it to a human rather than guessing. A row that is
 * already `running` is exactly that case, and is refused here for the same reason.
 *
 * A `ready_to_send` row is delivered as stored text. Re-entering generation for it is the
 * tool/escalation replay this whole design exists to prevent.
 */
export async function takeOutboxRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
): Promise<OutboxEntry> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status, generated_reply, generated_tool_calls")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) return { mode: "refuse", status: error ? `lookup failed: ${error.message}` : "missing" };

  if (row.status === "ready_to_send" && typeof row.generated_reply === "string") {
    return {
      mode: "redeliver",
      text: row.generated_reply,
      toolCalls: Array.isArray(row.generated_tool_calls) ? row.generated_tool_calls : null,
    };
  }
  if (row.status === "pending" && await advanceReply(admin, { id: outboxId, from: "pending", to: "running" })) {
    return { mode: "generate" };
  }
  return { mode: "refuse", status: row.status };
}

/**
 * The delivery half, shared by both entry points below:
 *
 *   ready_to_send -> sending   a delivery attempt is about to begin
 *   sending       -> sent      the provider returned
 *
 * The first is fail-closed: a row another worker has already moved to `sending` is being
 * delivered by that worker, and sending again is the duplicate reply this design prevents.
 *
 * The second is deliberately unchecked. By then the customer has the message; a failed
 * bookkeeping update must not turn a delivered reply into an error. The row stays in
 * `sending`, its lease lapses, and recovery classifies it delivery_unknown -- which is true.
 */
async function sendAndSettle(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  text: string,
  send: (text: string) => Promise<string>,
): Promise<string> {
  const claimed = await advanceReply(admin, { id: outboxId, from: "ready_to_send", to: "sending" });
  if (!claimed) throw new Error("another worker is already delivering this reply");

  let outboundMessageId: string;
  try {
    outboundMessageId = await send(text);
  } catch (error) {
    // Only reached when this process survives the throw. A killed isolate runs no catch --
    // which is why `sending` is durable and this is a courtesy, not the guarantee.
    await advanceReply(admin, {
      id: outboxId,
      from: "sending",
      to: "delivery_unknown",
      error: (error as Error)?.message ?? String(error),
    });
    throw error;
  }

  await advanceReply(admin, { id: outboxId, from: "sending", to: "sent" });
  return outboundMessageId;
}

/**
 * Sends a freshly generated reply, persisting it first.
 *
 * `running -> ready_to_send` is fail-closed: an unpersisted reply that goes out is one
 * nothing can reconcile afterwards, and the customer is better served by the recovery pass
 * than by a message no record exists of.
 */
export async function deliverGeneratedReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  reply: { text: string; toolCalls: unknown[] },
  send: (text: string) => Promise<string>,
): Promise<string> {
  const { text } = reply;
  const persisted = await advanceReply(admin, {
    id: outboxId,
    from: "running",
    to: "ready_to_send",
    generatedReply: text,
    // Stored WITH the reply, in the same statement, so a redelivery can never have the text
    // without knowing what produced it.
    generatedToolCalls: reply.toolCalls,
  });
  if (!persisted) throw new Error("could not persist the reply before sending; refusing to send");
  return await sendAndSettle(admin, outboxId, text, send);
}

/**
 * Sends text an earlier attempt already persisted. Regenerates nothing, so no tool call,
 * escalation or notification can repeat.
 */
export function deliverStoredReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  text: string,
  send: (text: string) => Promise<string>,
): Promise<string> {
  return sendAndSettle(admin, outboxId, text, send);
}

/**
 * What to do with a `running` row when generation failed and this process is still alive
 * to say what happened.
 *
 * A live process knows something a killed one cannot: whether any tool, escalation or
 * notification actually fired. If none did, the row goes back to `pending` and recovery may
 * retry it. If one did, it stays `running` -- the state recovery reads as "hand to a human".
 */
export async function releaseAfterError(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  outcome: { sideEffectsHappened: boolean; error: string },
): Promise<void> {
  if (outcome.sideEffectsHappened) return;
  await advanceReply(admin, { id: outboxId, from: "running", to: "pending", error: outcome.error });
}

/**
 * A gate closed or the agent chose silence: terminal, and nothing was sent.
 *
 * The from-state is read rather than assumed, because the callers cannot all know it. The
 * delivery gates (agent disabled, cooldown, daily cap, human takeover) run BEFORE
 * takeOutboxRow, so the row is `pending` on a fresh message but `ready_to_send` on a
 * redelivery -- and a hardcoded "pending" silently refused the cancel there, leaving the row
 * to lapse and be retried into the same gate until its attempts ran out. The customer's
 * outcome was still terminal, but it arrived as `recovery_failed` three attempts later
 * instead of `cancelled` immediately.
 *
 * The read is not a race: advance_agent_reply still only moves a row that is in the state
 * named, so a row someone else has taken in the meantime is refused, which is correct.
 */
export async function cancelOutboxRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  reason: string,
): Promise<boolean> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) {
    console.error(`[outbox] could not read ${outboxId} to cancel it: ${error?.message ?? "missing"}`);
    return false;
  }
  // Only from a state where nothing has been sent. advance_agent_reply enforces the FROM
  // state but not which pairs are legal, so a stale caller could otherwise rewrite `sending`,
  // `sent` or `delivery_unknown` as `cancelled` -- turning a reply the customer may have
  // received into a record saying nothing was attempted, which is the one lie this table
  // must never tell.
  if (!CANCELLABLE.includes(row.status)) {
    console.warn(`[outbox] refusing to cancel ${outboxId}: ${row.status} is past the point of no send`);
    return false;
  }
  return await advanceReply(admin, { id: outboxId, from: row.status, to: "cancelled", error: reason });
}

const CANCELLABLE: readonly string[] = ["pending", "running", "ready_to_send"];
