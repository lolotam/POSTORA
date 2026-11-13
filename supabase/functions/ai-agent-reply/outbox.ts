// How ai-agent-reply moves an outbox row through the states that matter to delivery.
//
// A sibling of index.ts rather than part of it because index.ts is a Deno.serve module --
// importing it starts a server -- and these three functions are the ones whose ORDER is the
// safety argument. They are tested with a stub that refuses a transition from the wrong
// state, exactly as advance_agent_reply does.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md, Task 4.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  advanceReply,
  type HumanModeAckClaim,
  type ReplyEscalation,
  type ReplyTransition,
} from "../_shared/pendingReplies.ts";

export type { HumanModeAckClaim, ReplyEscalation };

/**
 * What a row's stored text is.
 *
 * "reply" is an answer the model produced. "human_mode_ack" is the one-time
 * notice that tells the customer a human has their conversation. They are not
 * interchangeable: under a human takeover the answer may never be delivered,
 * while the notice is a promise that was already made.
 */
export type StoredReplyKind = "reply" | "human_mode_ack";

/**
 * What the row's kind column holds for a stored text of this kind.
 *
 * The column is NULL for an answer the model produced and 'human_mode_ack' for the
 * one-time notice; that is the contract the migration documents. The delivery claim
 * compares against the COLUMN, so the value it is given has to be the column's.
 */
export function storedKindValue(kind: StoredReplyKind): string | null {
  return kind === "human_mode_ack" ? "human_mode_ack" : null;
}

/**
 * What was actually sent, and what it was.
 *
 * The text is the STORED one: the row is the record of what the customer is owed, and a
 * caller that sent its own snapshot would write a thread turn that says something the
 * customer never received.
 */
export interface DeliveredReply {
  /** The id the provider returned for the message. */
  messageId: string;
  /** The text that went out. */
  text: string;
  /** What that text is. */
  kind: StoredReplyKind;
}

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
 * The tenant that owns the row, for a caller that does not name one.
 *
 * Every transition binds the row to a tenant, so the caller has to say whose reply it is
 * moving: the database refuses a row of another tenant exactly as it refuses a row that is
 * not in the from-state. A caller that knows its tenant says so. A caller that does not
 * gets the row's own tenant, and the move is bound to that -- the move is still a
 * tenant-bound move, it simply cannot catch a row id this caller mixed up.
 */
async function rowOwner(admin: SupabaseClient, outboxId: string): Promise<string | null> {
  const { data, error } = await admin
    .from("pending_agent_replies")
    .select("user_id")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !data) {
    console.error(`[outbox] could not read the owner of ${outboxId}: ${error?.message ?? "missing"}`);
    return null;
  }
  return typeof data.user_id === "string" ? data.user_id : null;
}

/**
 * Moves the row, bound to the tenant it belongs to.
 *
 * The tenant the caller names wins; a caller that names none gets the row's own. A row
 * whose tenant cannot be read is not moved at all: the move is bound to a tenant, and a
 * move without one is not a move this build is allowed to make.
 */
async function advanceOwnedReply(
  admin: SupabaseClient,
  outboxId: string,
  userId: string | null | undefined,
  transition: Omit<ReplyTransition, "id" | "userId">,
): Promise<boolean> {
  const owner = userId ?? await rowOwner(admin, outboxId);
  if (!owner) {
    console.error(
      `[outbox] ${transition.from} -> ${transition.to} refused for ${outboxId}: the row's tenant is unknown`,
    );
    return false;
  }
  return await advanceReply(admin, { ...transition, id: outboxId, userId: owner });
}

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
  admin: SupabaseClient,
  outboxId: string,
  userId?: string,
): Promise<OutboxEntry> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status, generated_reply, generated_tool_calls, generated_kind, user_id")
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
  // The tenant that owns the row, so the move is bound to it. The caller's own tenant
  // wins: a row of another tenant is then refused rather than moved.
  const owner = typeof row.user_id === "string" ? row.user_id : null;
  if (
    row.status === "pending" &&
    await advanceOwnedReply(admin, outboxId, userId ?? owner, { from: "pending", to: "running" })
  ) {
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
  admin: SupabaseClient,
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
 * The notice and the claim it spends are written by ONE statement. A notice that is
 * durable with its claim still owed is a notice a later turn takes the expired lease
 * over and sends again, and the customer is told twice that a human has their
 * conversation -- so the claim is required here, and a replacement without one is
 * refused rather than written.
 *
 * The transition is fail-closed: a row that is no longer in `ready_to_send` is
 * somebody else's now, and the caller has to know that rather than assume it.
 */
export async function replaceStoredReply(
  admin: SupabaseClient,
  outboxId: string,
  replacement: { text: string; kind: StoredReplyKind },
  claim: HumanModeAckClaim,
  userId?: string,
): Promise<boolean> {
  return await advanceOwnedReply(admin, outboxId, userId, {
    from: "ready_to_send",
    to: "ready_to_send",
    generatedReply: replacement.text,
    // The COLUMN's value, not the kind's name: the column is NULL for an answer and
    // 'human_mode_ack' for the notice, and the delivery claim compares against it.
    generatedKind: storedKindValue(replacement.kind),
    replaceAndCompleteClaim: claim,
  });
}

/**
 * The row was not deliverable as the caller read it.
 *
 * Either another worker is already delivering it, or its text was replaced between the
 * read and the claim -- a closed gate takes the row's place with the notice it owes.
 * Both are refusals, and both are fail-closed: nothing is sent.
 */
export class ReplyNotDeliverableError extends Error {
  constructor(
    message = "the row is not deliverable as it was read: another worker is already delivering it, or its text was replaced",
  ) {
    super(message);
    this.name = "ReplyNotDeliverableError";
  }
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
 * It is fail-closed about the PAYLOAD too. The row's text is read without a lock, so a
 * closed gate can replace it between the read and the claim -- the row stays in
 * `ready_to_send`, so the replacement is not refused. A delivery that sent the OLD text
 * would hand the customer an answer the closed gate was meant to block, and the notice
 * would never go out. The claim therefore carries the payload the caller read, and the
 * row is only moved while it holds exactly that payload. A successful claim IS the
 * proof that the row holds this payload, so the send uses it directly: a second read
 * would add a way to fail on a reply the provider had never been called for.
 *
 * The second is deliberately unchecked. By then the customer has the message; a failed
 * bookkeeping update must not turn a delivered reply into an error. The row stays in
 * `sending`, its lease lapses, and recovery classifies it delivery_unknown -- which is true.
 */
async function sendAndSettle(
  admin: SupabaseClient,
  outboxId: string,
  expected: { text: string; kind: StoredReplyKind },
  send: (text: string) => Promise<string>,
  userId?: string,
): Promise<DeliveredReply> {
  const claimed = await advanceOwnedReply(admin, outboxId, userId, {
    from: "ready_to_send",
    to: "sending",
    expectedPayload: { text: expected.text, kind: storedKindValue(expected.kind) },
  });
  if (!claimed) throw new ReplyNotDeliverableError();

  // The claim compared the row against the payload the caller read and moved it only
  // while the two matched, so the row HOLDS this payload -- and it is in `sending` now,
  // so nothing may replace it. There is no second read here: a read that failed would
  // strand a reply the provider had never been called for, and recovery would then
  // classify a definitely unsent reply as delivery_unknown instead of retrying it.
  let outboundMessageId: string;
  try {
    outboundMessageId = await send(expected.text);
  } catch (error) {
    // Only reached when this process survives the throw. A killed isolate runs no catch --
    // which is why `sending` is durable and this is a courtesy, not the guarantee.
    await advanceOwnedReply(admin, outboxId, userId, {
      from: "sending",
      to: "delivery_unknown",
      error: (error as Error)?.message ?? String(error),
    });
    throw error;
  }

  await advanceOwnedReply(admin, outboxId, userId, { from: "sending", to: "sent" });
  return { messageId: outboundMessageId, text: expected.text, kind: expected.kind };
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
 *
 * `humanModeAck` is the same promise for the one-time notice: the notice and the claim
 * it spends are ONE statement. A notice persisted with its claim still owed is a notice
 * a later turn sends again, and the customer is told twice that a human has the
 * conversation. It is mutually exclusive with `escalation` -- a notice resolves no
 * window, and a reply with an apology is not the notice.
 */
export async function deliverGeneratedReply(
  admin: SupabaseClient,
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
    /**
     * The acknowledgement claim the one-time notice spends, when the text is that notice.
     *
     * Set, the notice and the completion of the claim are written by ONE statement, so
     * there is no point between them at which a worker can die and leave the claim owed
     * on a notice the customer already has.
     */
    humanModeAck?: HumanModeAckClaim | null;
  },
  send: (text: string) => Promise<string>,
  userId?: string,
): Promise<DeliveredReply> {
  const { text } = reply;
  if (reply.kind === "human_mode_ack" && !reply.humanModeAck) {
    // A notice is never persisted without the claim it spends. The notice and the claim
    // are one fact, and a notice that is durable with its claim still owed is a notice
    // the next turn sends again: the customer is told twice that a human has the
    // conversation. Refusing to persist it leaves the work item unsettled, so the outbox
    // tries again and the claim is taken with a token.
    throw new ReplyNotPersistedError("the notice has no acknowledgement claim to spend");
  }
  const persisted = await advanceOwnedReply(admin, outboxId, userId, {
    from: "running",
    to: "ready_to_send",
    generatedReply: text,
    // Stored WITH the reply, in the same statement, so a redelivery can never have the text
    // without knowing what produced it.
    generatedToolCalls: reply.toolCalls,
    // The COLUMN's value: NULL for an answer the model produced, 'human_mode_ack' for
    // the notice. The delivery claim compares against the column, so a kind name that
    // is not the column's value would make the row refuse its own delivery.
    generatedKind: reply.kind ? storedKindValue(reply.kind) : null,
    escalation: reply.escalation ?? null,
    humanModeAck: reply.humanModeAck ?? null,
  });
  if (!persisted) throw new ReplyNotPersistedError();
  return await sendAndSettle(admin, outboxId, { text, kind: reply.kind ?? "reply" }, send, userId);
}

/**
 * Sends text an earlier attempt already persisted. Regenerates nothing, so no tool call,
 * escalation or notification can repeat.
 *
 * The payload the caller read travels with the claim, so a row whose text was replaced
 * in the meantime is not sent: what goes out is what the row holds.
 */
export async function deliverStoredReply(
  admin: SupabaseClient,
  outboxId: string,
  stored: { text: string; kind: StoredReplyKind },
  send: (text: string) => Promise<string>,
  userId?: string,
): Promise<DeliveredReply> {
  return await sendAndSettle(admin, outboxId, stored, send, userId);
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
  admin: SupabaseClient,
  outboxId: string,
  outcome: { sideEffectsHappened: boolean; error: string },
  userId?: string,
): Promise<void> {
  if (outcome.sideEffectsHappened) return;
  await advanceOwnedReply(admin, outboxId, userId, { from: "running", to: "pending", error: outcome.error });
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
  admin: SupabaseClient,
  outboxId: string,
  reason: string,
  userId?: string,
): Promise<boolean> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status, user_id")
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
  // The caller's tenant wins; a caller that names none gets the row's own, so the move
  // is bound to a tenant either way.
  const owner = typeof row.user_id === "string" ? row.user_id : null;
  return await advanceOwnedReply(admin, outboxId, userId ?? owner, {
    from: row.status,
    to: "cancelled",
    error: reason,
  });
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
  admin: SupabaseClient,
  outboxId: string,
  reason: string,
  userId?: string,
): Promise<OutboxSettlement> {
  const { data: row, error } = await admin
    .from("pending_agent_replies")
    .select("status, user_id")
    .eq("id", outboxId)
    .maybeSingle();
  if (error || !row) {
    console.error(`[outbox] could not read ${outboxId} to settle it: ${error?.message ?? "missing"}`);
    return "unsettled";
  }
  // A row that is already terminal settles the work item whoever gets there.
  if (!CANCELLABLE.includes(row.status)) return "settled";
  // The caller's tenant wins; a caller that names none gets the row's own, so the move
  // is bound to a tenant either way.
  const owner = typeof row.user_id === "string" ? row.user_id : null;
  const cancelled = await advanceOwnedReply(admin, outboxId, userId ?? owner, {
    from: row.status,
    to: "cancelled",
    error: reason,
  });
  return cancelled ? "cancelled" : "unsettled";
}
