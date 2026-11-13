// The outbox client: records an inbound message as work that must eventually produce a
// reply, and moves that record through its states.
//
// The point of this module is that the record outlives the isolate. Everything the agent
// needs to run from scratch is written down BEFORE the work starts, because the worker can
// die at any point during it and a row written afterwards would never exist.
//
// This is the only module that knows the table's shape and its RPCs. Callers see two
// operations: "enqueue, and tell me whether I own it" and "move from this state to that
// one, and tell me whether it happened". Both are non-throwing, for different reasons that
// are spelled out on each.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md

export interface PendingReplyItem {
  socialAccountId: string;
  platform: string;
  /** The platform's own id for the INBOUND message. Dedup key with the account. */
  messageId: string;
  conversationId: string;
  recipientId: string;
  /** The placeholder as it stood at enqueue time -- understanding has not happened yet. */
  inboundText: string;
  /** The platform's timestamp, not now(): a delayed webhook must not reorder the queue. */
  inboundAt: string;
  mediaUrl?: string | null;
  mediaKind?: string | null;
  mediaCaption?: string | null;
  unreadAttachments?: number;
  languageHint?: string | null;
  commentId?: string | null;
}

export type PendingReplyStatus =
  | "pending"
  | "running"
  | "ready_to_send"
  | "sending"
  | "sent"
  | "delivery_unknown"
  | "failed"
  | "cancelled";

export interface EnqueueOutcome {
  id: string;
  /**
   * False means another invocation already owns this work -- a webhook redelivery, or the
   * same message racing itself. That caller must NOT start processing: the owner is either
   * still running or the recovery job will take it when its lease lapses.
   */
  newlyEnqueued: boolean;
}

export function toEnqueueArgs(item: PendingReplyItem): Record<string, unknown> {
  return {
    p_social_account_id: item.socialAccountId,
    p_platform: item.platform,
    p_message_id: item.messageId,
    p_conversation_id: item.conversationId,
    p_recipient_id: item.recipientId,
    p_inbound_text: item.inboundText,
    p_inbound_at: item.inboundAt,
    // Always an object: the SQL reads p_media->>'url', and a JSON null there is an error
    // where an absent key is a NULL column.
    p_media: {
      url: item.mediaUrl ?? null,
      kind: item.mediaKind ?? null,
      caption: item.mediaCaption ?? null,
      unread: item.unreadAttachments ?? 0,
      // Meta's webhook carries no expiry and its signature is opaque, so no caller can
      // populate this today. It stays in the contract for a transport that can.
      expires_at: null,
    },
    p_language_hint: item.languageHint ?? null,
    p_comment_id: item.commentId ?? null,
  };
}

/**
 * Records the work item and reports whether THIS caller created it.
 *
 * Never throws and never blocks the reply. `null` means the record could not be made at all
 * -- a reply with no outbox row is strictly better than no reply, and that is the one
 * degradation this design accepts. It is deliberately distinct from `newlyEnqueued: false`,
 * which means the row exists and someone else owns it; conflating the two is what let a
 * webhook redelivery reply twice.
 */
export async function enqueueAgentReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  item: PendingReplyItem,
): Promise<EnqueueOutcome | null> {
  const label = `${item.platform}/${item.messageId}`;

  // Two attempts, because the RPC is idempotent and a lost RESPONSE is not a lost INSERT.
  //
  // Postgres can commit the row and then fail to return -- a dropped connection, a proxy
  // timeout. Reporting that as "no row" would send the reply now AND leave a committed
  // `pending` row for recovery to send again in a few minutes: a duplicate, from the very
  // path meant to prevent them. A retry resolves it, because ON CONFLICT DO NOTHING makes
  // the second call return the committed row with newly_enqueued=false.
  for (let attempt = 0; attempt < 2; attempt++) {
    const outcome = await attemptEnqueue(admin, item, label);
    if (outcome !== "unknown") return outcome;
  }

  // Both calls failed. A read is a different code path from a write and usually survives
  // when the write does not, so ask the table directly rather than guessing.
  const existing = await findExistingRow(admin, item, label);
  if (existing) return existing;

  // Genuinely unknown. Reply anyway: a reply with no outbox row is the degradation this
  // design accepts, and it is preferable to a customer who is answered by nobody. If a row
  // did commit and is invisible to all three of the calls above, recovery may still produce
  // a second reply -- which is why this is logged at error rather than swallowed.
  console.error(`[outbox] ownership for ${label} is UNKNOWN after 2 enqueues and a lookup; replying without a row`);
  return null;
}

async function attemptEnqueue(
  // deno-lint-ignore no-explicit-any
  admin: any,
  item: PendingReplyItem,
  label: string,
): Promise<EnqueueOutcome | null | "unknown"> {
  try {
    const { data, error } = await admin.rpc("enqueue_agent_reply", toEnqueueArgs(item));
    if (error) {
      console.error(`[outbox] could not record ${label}: ${error.message}`);
      return "unknown";
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.id !== "string" || typeof row.newly_enqueued !== "boolean") {
      // Unknown, NOT null. A response this code cannot read says nothing about whether the
      // insert committed, and answering row-less on a committed row is what produces a
      // recovery duplicate. The RPC is idempotent and the unique constraint stops a second
      // row, so the retry is free and may well return something readable.
      console.error(`[outbox] unexpected enqueue result for ${label}`);
      return "unknown";
    }
    if (!row.newly_enqueued) console.log(`[outbox] ${label} already owned by another invocation`);
    return { id: row.id, newlyEnqueued: row.newly_enqueued };
  } catch (error) {
    console.error(`[outbox] enqueue threw for ${label}:`, (error as Error)?.message ?? error);
    return "unknown";
  }
}

/** Did an earlier attempt commit after all? Never reports ownership -- only that a row exists. */
async function findExistingRow(
  // deno-lint-ignore no-explicit-any
  admin: any,
  item: PendingReplyItem,
  label: string,
): Promise<EnqueueOutcome | null> {
  try {
    const { data, error } = await admin
      .from("pending_agent_replies")
      .select("id")
      .eq("social_account_id", item.socialAccountId)
      .eq("message_id", item.messageId)
      .maybeSingle();
    if (error || !data?.id) return null;
    console.warn(`[outbox] ${label} committed despite a failed enqueue response; treating it as owned elsewhere`);
    // Deliberately not the owner: this caller never got a confirmed claim, so it must not
    // start work the row's real owner (or recovery) may also be doing.
    return { id: data.id, newlyEnqueued: false };
  } catch {
    return null;
  }
}

/**
 * The escalation window a reply resolves.
 *
 * The reply's text and the window's completion are written by ONE statement, so a worker
 * killed between them cannot leave the apology owed a second time.
 */
export interface ReplyEscalation {
  /** The thread whose marker this reply resolves. */
  threadId: string;
  /** The thread's owner. Tenancy is structural: the marker is only cleared for this user. */
  userId: string;
  /** The marker this turn leased. A newer window's marker is left alone. */
  since: string;
  /**
   * The lease token this turn holds on that marker.
   *
   * The marker alone does not say WHICH lease is being acted on: two workers that leased
   * the same marker hold the same `since`. The token is what a stale worker is refused
   * on, so it travels with the reply all the way to the statement that writes it.
   */
  claimToken: string;
}

/**
 * The one-time acknowledgement claim a notice is written under.
 *
 * The notice and the claim it spends are one fact: the customer is told a human has the
 * conversation, and no later turn may tell them again. Written as two statements, a
 * completion that failed left the notice delivered with the claim still owed.
 */
export interface HumanModeAckClaim {
  /** The conversation the claim belongs to. */
  userId: string;
  platform: string;
  conversationId: string;
  /**
   * The lease token of the claim this caller holds.
   *
   * Only the claim this caller holds can be spent, so a worker that was overtaken writes
   * nothing at all.
   */
  claimToken: string;
}

/**
 * The payload a row is expected to hold when a transition runs.
 *
 * The row's text is read without a lock, so anything that changes it can do so between
 * the read and the write. A transition that carries the payload only happens while the
 * row still holds exactly that payload, which is what keeps a replaced row from being
 * delivered.
 */
export interface ReplyPayload {
  /** The text the row is expected to hold. */
  text: string;
  /**
   * What that text is, as the row records it: null for an answer the model produced,
   * "human_mode_ack" for the one-time handoff notice.
   */
  kind: string | null;
}

/**
 * Moves the row from one state to the next, and reports whether it happened.
 *
 * This is the confirmed transition: the database only changes the row if it is still in
 * `from`, so two workers cannot both believe they moved it. Every external side effect in
 * the reply path is gated on a `true` here, and a caller that gets `false` MUST NOT proceed.
 *
 * Non-throwing, and that is not laziness. After the provider has accepted the message, a
 * throw from `sending -> sent` would turn a delivered reply into an error response. The row
 * is simply left where it was; its lease lapses; the recovery job classifies it from that
 * state -- which is exactly the truth. Do not "fix" this by making it throw.
 */
export interface ReplyTransition {
  id: string;
  from: PendingReplyStatus;
  to: PendingReplyStatus;
  generatedReply?: string | null;
  /** The tools that produced `generatedReply`, so a redelivery can record them truthfully. */
  generatedToolCalls?: unknown[] | null;
  /**
   * The escalation window this reply resolves, when it resolves one.
   *
   * Set, the text and the window's completion are written by ONE statement. Two statements
   * could leave the text durable and the marker owed: the reply is redelivered, and a
   * later turn takes the marker over once its lease lapses and apologises for the same
   * window a second time.
   */
  escalation?: ReplyEscalation | null;
  /**
   * The acknowledgement claim the one-time notice spends, when the text is that notice.
   *
   * Set, the text and the completion of the claim are written by ONE statement, and the
   * claim has to be the one this caller holds. A notice persisted without its claim
   * spent is a notice a later turn sends again.
   */
  humanModeAck?: HumanModeAckClaim | null;
  /**
   * The payload the row is expected to hold when this transition runs.
   *
   * Set on the delivery claim. The row's text is read without a lock, so a closed gate
   * can replace it between the read and the claim; the claim then moves the row only if
   * it still holds what the caller read, and the refusal is fail-closed -- nothing is
   * sent.
   */
  expectedPayload?: ReplyPayload | null;
  /**
   * What `generatedReply` is: null for an answer the model produced, "human_mode_ack" for
   * the one-time notice a human takeover owes the customer. A gate that is closed for the
   * answer is not closed for the notice, so a later turn has to be able to tell them apart.
   */
  generatedKind?: string | null;
  error?: string | null;
}

export async function advanceReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  transition: ReplyTransition,
): Promise<boolean> {
  // Named fields rather than positional: `from` and `to` are adjacent same-typed strings, and
  // a transposition would silently move the row backwards through the state machine.
  const { id, from, to } = transition;
  const generatedReply = transition.generatedReply ?? null;
  const error = transition.error?.slice(0, 500) ?? null;
  const toolCalls = transition.generatedToolCalls?.length ? transition.generatedToolCalls : null;

  // One RPC per KIND of transition, because each of them carries something the others do
  // not: the escalation window, the acknowledgement claim, or the payload the row is
  // expected to hold. The arguments are named exactly as the function declares them --
  // PostgREST matches a call by its argument names, and an argument the function does
  // not have is an error, not a default.
  let rpc: string;
  let args: Record<string, unknown>;
  if (transition.escalation) {
    // The reply and the window it resolves are ONE statement, and the window is only
    // consumed for the lease this caller holds.
    rpc = "persist_agent_reply_and_complete_escalation";
    args = {
      p_id: id,
      p_from: from,
      p_to: to,
      p_generated_reply: generatedReply,
      p_error: error,
      p_tool_calls: toolCalls,
      p_thread_id: transition.escalation.threadId,
      p_user_id: transition.escalation.userId,
      p_since: transition.escalation.since,
      p_claim_token: transition.escalation.claimToken,
    };
  } else if (transition.humanModeAck) {
    // The notice and the claim it spends are ONE statement, so a notice is never
    // delivered with its claim still owed.
    rpc = "persist_human_mode_ack_and_complete_claim";
    args = {
      p_id: id,
      p_from: from,
      p_to: to,
      p_generated_reply: generatedReply,
      p_error: error,
      p_tool_calls: toolCalls,
      p_generated_kind: transition.generatedKind ?? null,
      p_user_id: transition.humanModeAck.userId,
      p_platform: transition.humanModeAck.platform,
      p_conversation_id: transition.humanModeAck.conversationId,
      p_claim_token: transition.humanModeAck.claimToken,
    };
  } else if (transition.expectedPayload) {
    // The delivery claim carries the payload the caller read, so a row whose text was
    // replaced in the meantime is not moved and nothing is sent.
    rpc = "claim_agent_reply_for_delivery";
    args = {
      p_id: id,
      p_from: from,
      p_to: to,
      p_expected_reply: transition.expectedPayload.text,
      p_expected_kind: transition.expectedPayload.kind,
    };
  } else if (transition.generatedKind) {
    // The kind is written by the RPC that carries it, so a transition that does not need
    // one keeps working against a database that does not have the column yet.
    rpc = "advance_agent_reply_kind";
    args = {
      p_id: id,
      p_from: from,
      p_to: to,
      p_generated_reply: generatedReply,
      p_error: error,
      p_tool_calls: toolCalls,
      p_generated_kind: transition.generatedKind,
    };
  } else {
    rpc = "advance_agent_reply";
    args = {
      p_id: id,
      p_from: from,
      p_to: to,
      p_generated_reply: generatedReply,
      p_error: error,
      p_tool_calls: toolCalls,
    };
  }
  try {
    const { data, error: rpcError } = await admin.rpc(rpc, args);
    if (rpcError) {
      console.error(`[outbox] ${from} -> ${to} failed for ${id}: ${rpcError.message}`);
      return false;
    }
    if (data !== true) console.warn(`[outbox] ${from} -> ${to} refused for ${id}: not in ${from}`);
    return data === true;
  } catch (error) {
    console.error(`[outbox] ${from} -> ${to} threw for ${id}:`, (error as Error)?.message ?? error);
    return false;
  }
}
