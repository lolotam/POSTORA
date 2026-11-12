/**
 * The handoff window: the one-time acknowledgement a customer gets when the
 * conversation is with a human, and the apology owed when such a window ends
 * with no staff reply.
 *
 * Both are CLAIMS, and both are spent BEFORE the reply they belong to is
 * durable. The claim is what makes each notice single-flight, so it has to be
 * taken first -- but a delivery that never became durable would leave the
 * customer with nothing sent, nothing stored, and the claim gone with it: the
 * next turn meets a closed gate, says nothing, and the apology is never made.
 * The release functions here put the claim back so the next turn can make it.
 *
 * curemedkw, 2026-11-13.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  escalationApologyText,
  staffTurnsSince,
  type MessageRow,
  type ReplyLanguage,
  type StoredTurn,
  withOpening,
} from "./logic.ts";
import { ReplyNotPersistedError } from "./outbox.ts";

/** Staff replies merged in after an escalation window; the same order of size as the history. */
const STAFF_TURN_LIMIT = 14;

export type HumanModeWindow = "claimed" | "window" | "none";

/**
 * Which conversation the claims belong to. Every query carries user_id because
 * callers run as the service role and tenancy has to be structural
 * (ARCHITECTURE.md §24).
 */
export interface HandoffScope {
  userId: string;
  platform: string;
  conversationId: string;
}

export interface EscalationAftermath {
  /** When the silent window that ended began; null when the thread carries no marker. */
  since: string | null;
  /** Every staff send in the window, voice notes and images included. */
  staffReplies: number;
  /** The text of those sends, as history turns. */
  staffTurns: StoredTurn[];
}

export const NO_AFTERMATH: EscalationAftermath = { since: null, staffReplies: 0, staffTurns: [] };

/**
 * What the aftermath settlement did, so the caller can put the marker back when the
 * reply it belonged to never became durable.
 */
export interface AftermathSettlement {
  /** The reply to send, with the apology already opened when one was owed. */
  replyText: string;
  /** The marker this turn took, when it took one. */
  marker: string | null;
  /** The staff context could not be stored, so the marker has to come back. */
  staffWriteFailed: boolean;
}

/**
 * Where a closed gate stands with the one-time "our team has your conversation" notice.
 * "claimed": this message is the first into a bounded human_first window and owes the notice.
 * "window": the window was already notified. "none": no bounded window (manual override, a
 * human_first default, human_then_ai, another gate). The RPC is single-flight, so a second
 * message or a concurrent delivery never claims twice. A failed claim reads as "none":
 * silence is what the gate decided anyway.
 */
export async function claimHumanModeAck(
  admin: SupabaseClient,
  scope: HandoffScope,
  options: { gateReason: string; isComment: boolean },
): Promise<HumanModeWindow> {
  if (options.gateReason !== "mode_human_first" || scope.platform !== "whatsapp" || options.isComment) {
    return "none";
  }
  const { data, error } = await admin.rpc("claim_human_mode_ack", {
    p_user_id: scope.userId,
    p_platform: scope.platform,
    p_conversation_id: scope.conversationId,
  });
  if (error) {
    console.error("[ai-agent-reply] human-mode ack claim failed:", error.message);
    return "none";
  }
  return data === "claimed" || data === "window" ? data : "none";
}

/**
 * Puts the human-mode acknowledgement claim back so the customer still gets the notice.
 *
 * The claim is spent before the send, so a send that never became durable would leave
 * the customer with no acknowledgement at all: the next turn meets the closed gate as
 * "window" and says nothing.
 */
export async function releaseHumanModeAck(
  admin: SupabaseClient,
  scope: HandoffScope,
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_human_mode_ack", {
    p_user_id: scope.userId,
    p_platform: scope.platform,
    p_conversation_id: scope.conversationId,
  });
  if (error) {
    console.error("[ai-agent-reply] human-mode acknowledgement release failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * Puts the escalation marker back so the apology is still owed.
 *
 * The marker is a claim, not a receipt: it is spent before the reply it belongs to is
 * durable, and a reply that never became durable leaves the customer owed an apology
 * nobody will ever make. A marker that is already set is newer than this one and is
 * left alone.
 */
export async function restoreUnansweredEscalation(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
  since: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("restore_unanswered_escalation", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_since: since,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation restore failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * Whether the reply that failed exists anywhere durable.
 *
 * With an outbox row the text is persisted BEFORE the send, so a failure after that
 * leaves a row recovery can deliver from: the reply exists, and the claim spent on it
 * must stay spent. Without one, or when the persist itself failed, nothing durable
 * exists and the claim has to come back.
 */
export function replyIsDurable(outboxId: string | null, error: unknown): boolean {
  if (!outboxId) return false;
  return !(error instanceof ReplyNotPersistedError);
}

/**
 * The staff messages sent since the escalation marker.
 *
 * Read fresh at the moment it is needed. The first read happens before the model
 * runs; a staff reply that lands while the model is answering must still count,
 * or the agent apologises for a delay staff had already answered.
 */
async function readStaffReplies(
  admin: SupabaseClient,
  scope: HandoffScope,
  since: string,
): Promise<{ rows: MessageRow[]; failed: boolean }> {
  const { data: rows, error } = await admin
    .from("whatsapp_messages")
    .select("direction, from_name, message_text, created_at")
    .eq("user_id", scope.userId)
    .eq("conversation_id", scope.conversationId)
    .eq("direction", "outbound")
    .eq("from_name", "You")
    .gt("created_at", since)
    .order("created_at", { ascending: false })
    .limit(STAFF_TURN_LIMIT);
  if (error) {
    console.error("[ai-agent-reply] staff replies read failed:", error.message);
    return { rows: [], failed: true };
  }
  return { rows: rows ?? [], failed: false };
}

/**
 * The thread's unanswered-escalation marker and what staff sent since it. Read only: the
 * marker is taken by settleEscalationAftermath once the reply is final, so a turn that fails
 * before sending leaves it for the next one.
 *
 * Read fresh rather than from the thread upsert: the override read that runs beside the
 * upsert is what writes the marker. A failed staff read reports no marker: claiming a delay
 * staff may in fact have answered is worse than omitting the apology.
 */
export async function readEscalationAftermath(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
): Promise<EscalationAftermath> {
  const { data: marked, error } = await admin
    .from("ai_threads")
    .select("unanswered_escalation_since")
    .eq("id", threadId)
    .eq("user_id", scope.userId)
    .maybeSingle();
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation read failed:", error.message);
    return NO_AFTERMATH;
  }
  const since = marked?.unanswered_escalation_since;
  if (typeof since !== "string") return NO_AFTERMATH;
  const staff = await readStaffReplies(admin, scope, since);
  if (staff.failed) return NO_AFTERMATH;

  return { since, staffReplies: staff.rows.length, staffTurns: staffTurnsSince(staff.rows, since) };
}

/**
 * Takes the marker for the reply about to be sent, and returns that reply.
 *
 * Only the turn whose take succeeds acts: with no staff reply in the window it opens with the
 * apology; otherwise the staff turns are stored in the thread so later turns keep them too.
 *
 * The staff window is read again here, against the stamp that was actually taken: a staff
 * reply that landed while the model was answering belongs to this window too.
 */
export async function settleEscalationAftermath(
  admin: SupabaseClient,
  context: { scope: HandoffScope; threadId: string; language: ReplyLanguage },
  aftermath: EscalationAftermath,
  replyText: string,
): Promise<AftermathSettlement> {
  if (aftermath.since === null) return { replyText, marker: null, staffWriteFailed: false };
  const { data: taken, error } = await admin.rpc("take_unanswered_escalation", {
    p_thread_id: context.threadId,
    p_user_id: context.scope.userId,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation take failed:", error.message);
    return { replyText, marker: null, staffWriteFailed: false };
  }
  if (typeof taken !== "string") return { replyText, marker: null, staffWriteFailed: false };

  const staff = await readStaffReplies(admin, context.scope, taken);
  if (staff.failed) {
    // The window could not be read, so nothing is claimed about it: no apology
    // (staff may have answered) and no staff turns to store. The marker stays
    // taken, because it was claimed and the reply is still going out.
    return { replyText, marker: taken, staffWriteFailed: false };
  }
  const apology = escalationApologyText(taken, staff.rows.length, context.language);
  if (apology) return { replyText: withOpening(replyText, apology), marker: taken, staffWriteFailed: false };
  if (!staff.rows.length) return { replyText, marker: taken, staffWriteFailed: false };

  const { error: staffWriteError } = await admin.from("ai_thread_messages").insert(
    staffTurnsSince(staff.rows, taken).map((turn) => ({
      thread_id: context.threadId,
      user_id: context.scope.userId,
      role: turn.role,
      content: turn.content,
      created_at: turn.created_at,
    })),
  );
  if (staffWriteError) {
    console.error("[ai-agent-reply] staff turn write failed:", staffWriteError.message);
    // The staff context is still owed to the thread. The marker carries it, so it
    // goes back and the next turn can store the staff replies that this one lost.
    return { replyText, marker: taken, staffWriteFailed: true };
  }
  return { replyText, marker: taken, staffWriteFailed: false };
}
