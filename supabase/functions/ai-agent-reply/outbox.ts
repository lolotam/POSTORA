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
  /** Text from an earlier attempt is durable; deliver it and touch nothing else. */
  | { mode: "redeliver"; text: string }
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
    .select("status, generated_reply")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) return { mode: "refuse", status: error ? `lookup failed: ${error.message}` : "missing" };

  if (row.status === "ready_to_send" && typeof row.generated_reply === "string") {
    return { mode: "redeliver", text: row.generated_reply };
  }
  if (row.status === "pending" && await advanceReply(admin, outboxId, "pending", "running")) {
    return { mode: "generate" };
  }
  return { mode: "refuse", status: row.status };
}

/**
 * Sends a reply through three durable steps, each confirmed before the next:
 *
 *   running       -> ready_to_send   the text is now durable
 *   ready_to_send -> sending         a delivery attempt is about to begin
 *   sending       -> sent            the provider returned
 *
 * The first two are fail-closed: a refusal means the reply is NOT sent. An unpersisted reply
 * that goes out is one nothing can reconcile afterwards, and a row another worker has
 * already moved to `sending` is being delivered by that worker.
 *
 * The last is deliberately unchecked. By then the customer has the message; a failed
 * bookkeeping update must not turn a delivered reply into an error. The row stays in
 * `sending`, its lease lapses, and recovery classifies it delivery_unknown -- which is true.
 *
 * `text` may be null when the row is already `ready_to_send` (a redelivery): the first
 * transition is then skipped rather than refused, and the stored text is what goes out.
 */
export async function deliverThroughOutbox(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  text: string,
  send: (text: string) => Promise<string>,
  options: { alreadyPersisted?: boolean } = {},
): Promise<string> {
  if (!options.alreadyPersisted) {
    const persisted = await advanceReply(admin, outboxId, "running", "ready_to_send", { generatedReply: text });
    if (!persisted) throw new Error("could not persist the reply before sending; refusing to send");
  }
  const claimed = await advanceReply(admin, outboxId, "ready_to_send", "sending");
  if (!claimed) throw new Error("another worker is already delivering this reply");

  let outboundMessageId: string;
  try {
    outboundMessageId = await send(text);
  } catch (error) {
    // Only reached when this process survives the throw. A killed isolate runs no catch --
    // which is why `sending` is durable and this is a courtesy, not the guarantee.
    await advanceReply(admin, outboxId, "sending", "delivery_unknown", {
      error: (error as Error)?.message ?? String(error),
    });
    throw error;
  }

  await advanceReply(admin, outboxId, "sending", "sent");
  return outboundMessageId;
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
  await advanceReply(admin, outboxId, "running", "pending", { error: outcome.error });
}

/** A gate closed or the agent chose silence: terminal, and nothing was sent. */
export async function cancelOutboxRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  from: "pending" | "running",
  reason: string,
): Promise<void> {
  await advanceReply(admin, outboxId, from, "cancelled", { error: reason });
}
