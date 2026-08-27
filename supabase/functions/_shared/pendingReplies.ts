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
  try {
    const { data, error } = await admin.rpc("enqueue_agent_reply", toEnqueueArgs(item));
    if (error) {
      console.error(`[outbox] could not record ${label}: ${error.message}`);
      return null;
    }
    const row = Array.isArray(data) ? data[0] : data;
    if (!row || typeof row.id !== "string" || typeof row.newly_enqueued !== "boolean") {
      // Fail closed on ownership. Reading garbage as "newly enqueued" would let two
      // invocations both believe they own the row.
      console.error(`[outbox] unexpected enqueue result for ${label}`);
      return null;
    }
    if (!row.newly_enqueued) console.log(`[outbox] ${label} already owned by another invocation`);
    return { id: row.id, newlyEnqueued: row.newly_enqueued };
  } catch (error) {
    console.error(`[outbox] enqueue threw for ${label}:`, (error as Error)?.message ?? error);
    return null;
  }
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
export async function advanceReply(
  // deno-lint-ignore no-explicit-any
  admin: any,
  id: string,
  from: PendingReplyStatus,
  to: PendingReplyStatus,
  extra: { generatedReply?: string | null; error?: string | null } = {},
): Promise<boolean> {
  try {
    const { data, error } = await admin.rpc("advance_agent_reply", {
      p_id: id,
      p_from: from,
      p_to: to,
      p_generated_reply: extra.generatedReply ?? null,
      p_error: extra.error?.slice(0, 500) ?? null,
    });
    if (error) {
      console.error(`[outbox] ${from} -> ${to} failed for ${id}: ${error.message}`);
      return false;
    }
    if (data !== true) console.warn(`[outbox] ${from} -> ${to} refused for ${id}: not in ${from}`);
    return data === true;
  } catch (error) {
    console.error(`[outbox] ${from} -> ${to} threw for ${id}:`, (error as Error)?.message ?? error);
    return false;
  }
}
