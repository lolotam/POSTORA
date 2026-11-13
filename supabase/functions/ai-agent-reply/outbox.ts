// How ai-agent-reply moves an outbox row through the states that matter to delivery.
//
// A sibling of index.ts rather than part of it because index.ts is a Deno.serve module --
// importing it starts a server -- and these three functions are the ones whose ORDER is the
// safety argument. They are tested with a stub that refuses a transition from the wrong
// state, exactly as advance_agent_reply does.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md, Task 4.
//
// The admin client is the service-role client, whose PostgREST builders have no
// generated type here: a structural type narrow enough to be useful would have to
// restate supabase-js's builder and would then drift from it. The same shape as
// the sibling edge modules.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { advanceReply, type ReplyEscalation } from "../_shared/pendingReplies.ts";

export type { ReplyEscalation };

/**
 * What a row's stored text is.
 *
 * "reply" is an answer the model produced. "human_mode_ack" is the one-time
 * notice that tells the customer a human has their conversation. They are not
 * interchangeable: under a human takeover the answer may never be delivered,
 * while the notice is a promise that was already made.
 */
export type StoredReplyKind = "reply" | "human_mode_ack";

export type OutboxEntry =
  /**
   * Text from an earlier attempt is durable; deliver it and touch nothing else. `toolCalls`
   * is what the ORIGINAL generation ran, carried so the thread row a redelivery writes says
   * where the answer came from instead of claiming it came from nowhere. `kind` says what the
   * text is, so a gate that is closed for the answer is not closed for the notice.
   */
  | { mode: "redeliver"; text: string; toolCalls: unknown[] | null; kind: StoredReplyKind }
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
    .select("status, generated_reply, generated_tool_calls, generated_kind")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) return { mode: "refuse", status: error ? `lookup failed: ${error.message}` : "missing" };

  if (row.status === "ready_to_send" && typeof row.generated_reply === "string") {
    return {
      mode: "redeliver",
      text: row.generated_reply,
      toolCalls: Array.isArray(row.generated_tool_calls) ? row.generated_tool_calls : null,
      kind: row.generated_kind === "human_mode_ack" ? "human_mode_ack" : "reply",
    };
  }
  if (row.status === "pending" && await advanceReply(admin, { id: outboxId, from: "pending", to: "running" })) {
    return { mode: "generate" };
  }
  return { mode: "refuse", status: row.status };
}

/**
 * What the outbox row holds, when the row could be read.
 */
export interface StoredReplyRow {
  /** The row's status, or null when there is no row at all. */
  status: string | null;
  /** The text the row holds that may still be delivered, or null when it holds none. */
  text: string | null;
  /** What that text is, or null when the row holds no deliverable text. */
  kind: StoredReplyKind | null;
}

/**
 * What the outbox row holds.
 *
 * A FAILED READ is not an empty row. Reading one as the other lets a gate decide that the
 * row holds nothing, take the notice's claim on that strength, and leave a stored answer
 * in a row the outbox then delivers -- under a gate that is closed for that answer. The
 * failed read is its own answer: the row's state is unknown, so nothing may be settled on
 * the strength of it.
 */
export type StoredReplyPeek =
  | { outcome: "read_failed"; error: string }
  | ({ outcome: "read" } & StoredReplyRow);

/**
 * The text a row already holds, without taking the row.
 *
 * Used to decide what a gate does with the row BEFORE anything is claimed: a row
 * that holds an answer written under an open gate may never be delivered under a
 * closed one, and a row that holds the notice has to be delivered as it was
 * persisted.
 *
 * A row that holds its text in `ready_to_send` is the only one that may still be
 * delivered. A row in `sending`, `sent` or `delivery_unknown` may already have gone
 * out, so it holds nothing deliverable -- and saying so is what keeps a notice from
 * being sent twice.
 */
export async function peekStoredReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
): Promise<StoredReplyPeek> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status, generated_reply, generated_kind")
    .eq("id", outboxId)
    .maybeSingle();
  if (error) {
    console.error(`[outbox] could not read ${outboxId}: ${error.message}`);
    return { outcome: "read_failed", error: error.message };
  }
  if (!row) return { outcome: "read", status: null, text: null, kind: null };
  const deliverable = row.status === "ready_to_send" && typeof row.generated_reply === "string";
  return {
    outcome: "read",
    status: row.status ?? null,
    text: deliverable ? row.generated_reply : null,
    kind: deliverable ? (row.generated_kind === "human_mode_ack" ? "human_mode_ack" : "reply") : null,
  };
}

/**
 * Puts different text into a row that already holds one, keeping its place in the
 * outbox.
 *
 * This is how the one-time notice takes over a row whose answer may not be
 * delivered: the row stays the durable record of what the customer is owed, and
 * recovery can still deliver it. The answer it replaces was written under an open
 * gate and was never sent, so nothing that reached the customer is overwritten.
 *
 * The transition is fail-closed: a row that is no longer in `ready_to_send` is
 * somebody else's now, and the caller has to know that rather than assume it.
 */
export async function replaceStoredReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  replacement: { text: string; kind: StoredReplyKind },
): Promise<boolean> {
  return await advanceReply(admin, {
    id: outboxId,
    from: "ready_to_send",
    to: "ready_to_send",
    generatedReply: replacement.text,
    generatedKind: replacement.kind,
  });
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
 * The reply text could not be persisted before the send, so nothing durable
 * exists anywhere.
 *
 * The caller needs to tell this apart from a send that failed AFTER the text
 * was stored: in that case the outbox row holds the reply and recovery can
 * still deliver it, so a claim spent on that reply must stay spent. Here
 * nothing was written, so a claim the caller holds has to come back.
 */
export class ReplyNotPersistedError extends Error {
  constructor(message = "could not persist the reply before sending; refusing to send") {
    super(message);
    this.name = "ReplyNotPersistedError";
  }
}

/**
 * Sends a freshly generated reply, persisting it first.
 *
 * `running -> ready_to_send` is fail-closed: an unpersisted reply that goes out is one
 * nothing can reconcile afterwards, and the customer is better served by the recovery pass
 * than by a message no record exists of.
 *
 * `kind` is stored WITH the text, in the same statement, so a later turn that finds the
 * row knows what the text is: an answer the model produced, or the one-time notice a
 * human takeover owes the customer. The two are settled differently under a closed gate.
 *
 * `escalation` is written with the text too, in the SAME statement. The reply carries the
 * apology, so the window it resolves and the reply that carries it are one fact: a worker
 * killed between "the reply is durable" and "the window is consumed" leaves the apology
 * owed a second time, and the customer is apologised to twice.
 */
export async function deliverGeneratedReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  reply: {
    text: string;
    toolCalls: unknown[];
    kind?: StoredReplyKind;
    /**
     * The escalation window this reply resolves, when it resolves one.
     *
     * Set, the text and the window's completion are written by ONE statement, so there is
     * no point between them at which a worker can die and leave the apology owed twice.
     */
    escalation?: ReplyEscalation | null;
  },
  send: (text: string) => Promise<string>,
  /**
   * Runs once the text is durable, before the send. A claim spent on this reply may be
   * consumed here: the reply exists, so a later turn must not make the same promise
   * again.
   */
  onPersisted?: () => Promise<void>,
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
    generatedKind: reply.kind ?? null,
    escalation: reply.escalation ?? null,
  });
  if (!persisted) throw new ReplyNotPersistedError();
  if (onPersisted) {
    try {
      await onPersisted();
    } catch (error) {
      // The reply is durable either way. A claim that could not be consumed here is
      // still leased, so the next turn takes it over rather than sending twice.
      console.error("[outbox] the post-persist hook failed:", (error as Error)?.message ?? String(error));
    }
  }
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

/**
 * What settling a work item under a closed gate did.
 *
 * "cancelled": the row is cancelled now. "settled": the row was already terminal -- a
 * previous attempt settled it, or a reply went out -- so the work item is done either
 * way. "unsettled": the row could not be settled, so the caller must NOT report the
 * work item as done: recovery re-drives the row, reaches the same gate and stores the
 * same customer turn again.
 */
export type OutboxSettlement = "cancelled" | "settled" | "unsettled";

/**
 * Settles the work item under a closed gate, and says what happened.
 *
 * The cancellation result matters to the caller: a row that is still open when the
 * caller says "skipped" is a work item that recovery re-drives into the same gate.
 */
export async function settleOutboxRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  outboxId: string,
  reason: string,
): Promise<OutboxSettlement> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) {
    console.error(`[outbox] could not read ${outboxId} to settle it: ${error?.message ?? "missing"}`);
    return "unsettled";
  }
  // A row that is already terminal settles the work item whoever gets there.
  if (!CANCELLABLE.includes(row.status)) return "settled";
  const cancelled = await advanceReply(admin, { id: outboxId, from: row.status, to: "cancelled", error: reason });
  return cancelled ? "cancelled" : "unsettled";
}
