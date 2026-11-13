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
 *
 * A claim that is CLEARED when it is taken cannot survive that: the worker that
 * took it may be killed between the claim and the durable write, and the claim
 * is gone with the worker. So both claims are LEASES here. A claim carries the
 * moment it was taken, a claim that never became durable can be taken over by
 * a later turn once its lease lapses, and a claim that DID become durable is
 * completed and never handed out twice.
 *
 * curemedkw, 2026-11-13.
 */
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import {
  escalationApologyText,
  HUMAN_MODE_ACK,
  staffTurnsSince,
  type MessageRow,
  type ReplyLanguage,
  type StoredTurn,
  withOpening,
} from "./logic.ts";
import { ReplyNotPersistedError, peekStoredReply, replaceStoredReply, settleOutboxRow } from "./outbox.ts";

/** Staff replies merged in after an escalation window; the same order of size as the history. */
const STAFF_TURN_LIMIT = 14;

export type HumanModeWindow = "claimed" | "window" | "none";

/**
 * How long a claim is held before another turn may take it over.
 *
 * The acknowledgement lease covers a notice that is persisted and sent: no model
 * runs on that path, so it is short, and it has to be short enough that a later
 * turn can still deliver a notice the worker that persisted it never sent.
 * The escalation lease covers a whole model turn, so it matches the outbox lease.
 */
export const ACK_CLAIM_LEASE_SECONDS = 120;
export const ESCALATION_CLAIM_LEASE_SECONDS = 180;

/**
 * What the acknowledgement claim says about the bounded human_first window.
 *
 * "claimed": this caller holds the claim and owes the notice. "window": the window
 * exists but the notice is not this caller's to send -- another worker holds the
 * claim, or the deployed build claimed it before the lease existed. "delivered":
 * the notice already reached the customer. "none": there is no bounded window.
 * "failed": the claim could not be read, so its state is unknown.
 */
export type AckClaimResult = "claimed" | "window" | "delivered" | "none" | "failed";

export interface AckClaim {
  result: AckClaimResult;
  /**
   * The lease token of the claim this caller holds. It identifies the claim, so a
   * release or a completion only ever touches the claim the caller actually took
   * and never a newer one.
   */
  claimToken: string | null;
}

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
  /** The marker this turn leased, when it leased one. */
  marker: string | null;
  /** The window could not be read, so the marker has to come back. */
  staffReadFailed: boolean;
  /** The staff context could not be stored, so the marker has to come back. */
  staffWriteFailed: boolean;
}

/**
 * Where a closed gate stands with the one-time "our team has your conversation" notice.
 *
 * The claim is a LEASE: it is taken before the notice is durable, and a claim that
 * never became durable can be taken over by a later turn once the lease lapses, so
 * a worker that is killed between the claim and the send does not swallow the
 * notice. The RPC is single-flight, so two turns never claim the same window twice
 * while the lease is live.
 *
 * A failed claim is "failed", never "none": the claim's state is unknown, so the
 * caller must not settle anything on the strength of it. Silently reading a failed
 * claim as "no window" would cancel the work item -- and with it the customer's
 * question -- over a database hiccup.
 */
export async function claimHumanModeAck(
  admin: SupabaseClient,
  scope: HandoffScope,
  options: { gateReason: string; isComment: boolean },
): Promise<AckClaim> {
  if (options.gateReason !== "mode_human_first" || scope.platform !== "whatsapp" || options.isComment) {
    return { result: "none", claimToken: null };
  }
  const { data, error } = await admin.rpc("claim_human_mode_ack_leased", {
    p_user_id: scope.userId,
    p_platform: scope.platform,
    p_conversation_id: scope.conversationId,
    p_lease_seconds: ACK_CLAIM_LEASE_SECONDS,
  });
  if (error) {
    console.error("[ai-agent-reply] human-mode ack claim failed:", error.message);
    return { result: "failed", claimToken: null };
  }
  const claim = (data ?? {}) as { result?: unknown; claim_token?: unknown };
  const result = claim.result;
  if (result !== "claimed" && result !== "window" && result !== "delivered" && result !== "none") {
    console.error("[ai-agent-reply] human-mode ack claim returned an unreadable result:", JSON.stringify(data));
    return { result: "failed", claimToken: null };
  }
  const token = typeof claim.claim_token === "string" ? claim.claim_token : null;
  return { result, claimToken: result === "claimed" ? token : null };
}

/**
 * Marks the acknowledgement as delivered, so no later turn sends the notice twice.
 *
 * Only the claim the caller holds can be completed: the token has to match the
 * claim that is live, so a stale caller cannot complete -- and so cannot release
 * -- a newer claim.
 */
export async function completeHumanModeAck(
  admin: SupabaseClient,
  scope: HandoffScope,
  claimToken: string | null,
): Promise<boolean> {
  if (!claimToken) return false;
  const { data, error } = await admin.rpc("complete_human_mode_ack", {
    p_user_id: scope.userId,
    p_platform: scope.platform,
    p_conversation_id: scope.conversationId,
    p_claim_token: claimToken,
  });
  if (error) {
    console.error("[ai-agent-reply] human-mode ack completion failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * Puts the human-mode acknowledgement claim back so the customer still gets the notice.
 *
 * The claim is spent before the send, so a send that never became durable would leave
 * the customer with no acknowledgement at all: the next turn meets the closed gate as
 * "window" and says nothing. The release only touches the claim the caller holds, so
 * a worker that was overtaken can never take the notice away from the worker that
 * replaced it.
 */
export async function releaseHumanModeAck(
  admin: SupabaseClient,
  scope: HandoffScope,
  claimToken: string | null,
): Promise<boolean> {
  if (!claimToken) return false;
  const { data, error } = await admin.rpc("release_human_mode_ack_claim", {
    p_user_id: scope.userId,
    p_platform: scope.platform,
    p_conversation_id: scope.conversationId,
    p_claim_token: claimToken,
  });
  if (error) {
    console.error("[ai-agent-reply] human-mode acknowledgement release failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * The customer's turn that arrived while the window was already notified.
 *
 * The assistant is silent for the whole window, so this turn is the ONLY durable record
 * of a question the customer asked and nobody answered: the reply path stores turns as
 * it answers them, and this one is never answered. A failed write is therefore reported,
 * not swallowed -- the caller keeps the work item unsettled so the turn can be stored
 * again, instead of settling a conversation whose question was lost.
 */
export async function storeHeldCustomerTurn(
  admin: SupabaseClient,
  threadId: string,
  turn: { userId: string; content: string; id?: string },
): Promise<{ stored: boolean; error: string | null }> {
  const { error } = await admin.from("ai_thread_messages").insert({
    // The work item's own id, so the same question is stored once. The turn write and
    // the cancellation that follows it are two statements, and a worker killed between
    // them leaves the row open: recovery re-drives it, reaches the same gate and
    // stores the same turn again. With this id the second write is refused as a
    // duplicate, and the thread keeps one copy of the question.
    ...(turn.id ? { id: turn.id } : {}),
    thread_id: threadId,
    user_id: turn.userId,
    role: "user",
    content: turn.content,
  });
  if (error) {
    // A unique violation is this exact turn, already stored: the question is durable,
    // which is what the caller asked for.
    if (error.code === "23505") return { stored: true, error: null };
    console.error("[ai-agent-reply] held customer turn write failed:", error.message);
    return { stored: false, error: error.message };
  }
  return { stored: true, error: null };
}

/**
 * What a closed gate does with the work item.
 *
 * A closed gate is a decision, so the work item is normally terminal: it is cancelled
 * and the caller is told the reply was skipped. The exception is the customer's turn
 * during an open window. That turn is the only record of a question nobody answered,
 * and when it cannot be stored the question is lost for good -- so the work item stays
 * unsettled and the caller is told the turn FAILED, not that the reply was skipped.
 * "Skipped" is terminal: it would tell the outbox the question was handled.
 */
export interface ClosedGateSettlement {
  /** The body the caller returns. `ok: false` is a failure the outbox may retry. */
  body: { ok: false; error: string } | { ok: true; skipped: string };
  /** Whether the work item was settled as done. */
  cancelWorkItem: boolean;
}

export async function settleClosedGate(input: {
  admin: SupabaseClient;
  outboxId: string | null;
  gateReason: string;
  humanWindow: HumanModeWindow;
  threadId: string;
  turn: { userId: string; content: string; id?: string };
}): Promise<ClosedGateSettlement> {
  // The customer's turn during an open window is the only durable record of a
  // question nobody answered, so it is stored before the turn is settled.
  const heldTurn = input.humanWindow === "window"
    ? await storeHeldCustomerTurn(input.admin, input.threadId, input.turn)
    : { stored: true, error: null };

  if (!heldTurn.stored) {
    // The question is not durable anywhere. The work item is left unsettled -- not
    // cancelled, not marked done -- so the outbox can try again, and the caller is
    // told the turn failed.
    return {
      body: { ok: false, error: heldTurn.error ?? "the customer's turn could not be stored" },
      cancelWorkItem: false,
    };
  }

  // Terminal for the work item: a closed gate is a decision, and recovery re-driving
  // the row would only reach the same gate.
  if (input.outboxId) {
    const settled = await settleOutboxRow(input.admin, input.outboxId, input.gateReason);
    if (settled === "unsettled") {
      // The row is still open, so the work item is NOT done. Reporting it as skipped
      // would tell the outbox the question was handled while the row is still there
      // to be re-driven into this same gate.
      return {
        body: { ok: false, error: "the work item could not be settled" },
        cancelWorkItem: false,
      };
    }
  }
  return { body: { ok: true, skipped: input.gateReason }, cancelWorkItem: true };
}

/**
 * What a closed gate decided to do.
 *
 * "notice": the customer is owed the one-time notice, and `text` is what goes out.
 * "skipped": nothing is owed; the gate is settled and the work item is terminal.
 * "retryable": the state could not be read, so nothing may be settled on the strength of
 * it -- the work item stays unsettled and the caller is told to try again.
 */
export type ClosedGateDecision =
  | { kind: "notice"; text: string; fromRow: boolean; claimToken: string | null }
  | { kind: "skipped"; settlement: ClosedGateSettlement }
  | { kind: "retryable"; error: string };

/**
 * Decides what a closed gate does with the one-time notice and with the answer the
 * outbox row may already hold.
 *
 * The row is classified FIRST, because the gate has to be applied to what the row
 * holds and not to what this invocation happens to produce:
 *
 *   * a row that holds an ANSWER was written while the gate was open. A closed gate
 *     must never deliver it, so the notice takes its place in the row -- the row stays
 *     the durable record of what the customer is owed, and recovery can still deliver
 *     it. The answer it replaces was never sent, so nothing the customer received is
 *     overwritten;
 *   * a row that holds the NOTICE is delivered from the row exactly as it was
 *     persisted, so a worker that died after persisting it does not swallow it;
 *   * a row that holds nothing is the ordinary case: the notice is persisted into it
 *     by the caller and sent.
 *
 * The claim is taken AFTER the row is classified, so the claim is only ever spent on a
 * notice this turn is going to deliver, and it is a LEASE: a turn that dies before the
 * notice is durable hands it back after the lease lapses.
 */
export async function settleClosedGateNotice(input: {
  admin: SupabaseClient;
  scope: HandoffScope;
  outboxId: string | null;
  gateReason: string;
  isComment: boolean;
  language: ReplyLanguage;
  threadId: string;
  turn: { userId: string; content: string; id?: string };
}): Promise<ClosedGateDecision> {
  const stored = input.outboxId ? await peekStoredReply(input.admin, input.outboxId) : null;
  const claim = await claimHumanModeAck(input.admin, input.scope, {
    gateReason: input.gateReason,
    isComment: input.isComment,
  });

  if (claim.result === "failed") {
    // The claim's state is unknown, so nothing may be settled on the strength of it: the
    // work item stays unsettled, and the customer's question is not lost over a hiccup.
    return { kind: "retryable", error: "the human-mode acknowledgement claim could not be read" };
  }

  if (claim.result === "claimed") {
    const notice = HUMAN_MODE_ACK[input.language];
    if (stored?.kind === "human_mode_ack") {
      // The notice was persisted by an earlier attempt. Deliver that text, not a new
      // one: this is the promise the customer was given.
      return { kind: "notice", text: stored.text, fromRow: true, claimToken: claim.claimToken };
    }
    if (stored && input.outboxId) {
      const replaced = await replaceStoredReply(input.admin, input.outboxId, {
        text: notice,
        kind: "human_mode_ack",
      });
      if (!replaced) {
        return { kind: "retryable", error: "the stored answer could not be replaced by the notice" };
      }
      return { kind: "notice", text: notice, fromRow: true, claimToken: claim.claimToken };
    }
    return { kind: "notice", text: notice, fromRow: false, claimToken: claim.claimToken };
  }

  if (stored?.kind === "human_mode_ack" && claim.result === "window") {
    // Another worker holds the notice's claim and is delivering it. The row is left
    // alone: cancelling it would take the notice away from that worker.
    return { kind: "retryable", error: "the human-mode notice is being delivered by another turn" };
  }

  // Nothing is owed here: the window was notified already, the notice was delivered, or
  // there is no bounded window at all. The stored answer is settled under this gate so
  // it can never be delivered later, and the customer's turn is kept.
  const settlement = await settleClosedGate({
    admin: input.admin,
    outboxId: input.outboxId,
    gateReason: input.gateReason,
    humanWindow: claim.result === "window" || claim.result === "delivered" ? "window" : "none",
    threadId: input.threadId,
    turn: input.turn,
  });
  return { kind: "skipped", settlement };
}

/**
 * Leases the escalation marker for the reply about to be sent.
 *
 * The marker is not cleared when it is taken: it is LEASED. A worker that dies
 * between the claim and the durable reply leaves the marker in place, and a later
 * turn takes the lease over once it lapses, so the apology is still made. The
 * marker is cleared only by completeUnansweredEscalation, when the reply it
 * belonged to became durable.
 *
 * A marker that is already leased by a live claim is not handed out twice.
 */
export async function claimUnansweredEscalation(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
): Promise<{ marker: string | null; claimed: boolean }> {
  const { data, error } = await admin.rpc("claim_unanswered_escalation", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_lease_seconds: ESCALATION_CLAIM_LEASE_SECONDS,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation claim failed:", error.message);
    return { marker: null, claimed: false };
  }
  if (typeof data !== "string") return { marker: null, claimed: false };
  return { marker: data, claimed: true };
}

/**
 * Consumes the escalation marker: the reply it belonged to became durable, so the
 * window is resolved and no later turn apologises for it.
 *
 * The marker has to be the one this turn leased, so a stale completion can never
 * clear a marker a newer window set.
 */
export async function completeUnansweredEscalation(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
  since: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("complete_unanswered_escalation", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_since: since,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation completion failed:", error.message);
    return false;
  }
  return data === true;
}

/**
 * Gives the escalation lease back so the apology is still owed.
 *
 * The marker itself was never cleared -- it is only leased -- so giving the lease
 * back is what lets a later turn claim it. A marker that is already set to a
 * different value is newer than this one and is left alone: overwriting it would
 * lose that window and its staff replies.
 */
export async function releaseUnansweredEscalationClaim(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
  since: string,
): Promise<boolean> {
  const { data, error } = await admin.rpc("release_unanswered_escalation_claim", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_since: since,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation release failed:", error.message);
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
 * Only the turn whose lease succeeds acts: with no staff reply in the window it opens with the
 * apology; otherwise the staff turns are stored in the thread so later turns keep them too.
 *
 * The staff window is read again here, against the stamp that was actually leased: a staff
 * reply that landed while the model was answering belongs to this window too.
 *
 * The marker is LEASED, not taken: it stays set until the reply it belongs to is durable,
 * so a turn that dies here leaves the apology owed rather than lost. A window that could
 * not be read hands the lease straight back for the same reason.
 */
export async function settleEscalationAftermath(
  admin: SupabaseClient,
  context: { scope: HandoffScope; threadId: string; language: ReplyLanguage },
  aftermath: EscalationAftermath,
  replyText: string,
): Promise<AftermathSettlement> {
  if (aftermath.since === null) {
    return { replyText, marker: null, staffReadFailed: false, staffWriteFailed: false };
  }
  const claim = await claimUnansweredEscalation(admin, context.scope, context.threadId);
  if (!claim.claimed || claim.marker === null) {
    return { replyText, marker: null, staffReadFailed: false, staffWriteFailed: false };
  }
  const taken = claim.marker;

  const staff = await readStaffReplies(admin, context.scope, taken);
  if (staff.failed) {
    // The window could not be read, so nothing is claimed about it: no apology
    // (staff may have answered) and no staff turns to store. The lease goes back,
    // so the next turn reads the window again instead of finding it consumed.
    return { replyText, marker: taken, staffReadFailed: true, staffWriteFailed: false };
  }
  const apology = escalationApologyText(taken, staff.rows.length, context.language);
  if (apology) {
    return { replyText: withOpening(replyText, apology), marker: taken, staffReadFailed: false, staffWriteFailed: false };
  }
  if (!staff.rows.length) {
    return { replyText, marker: taken, staffReadFailed: false, staffWriteFailed: false };
  }

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
    // The staff context is still owed to the thread. The marker carries it, so the
    // lease goes back and the next turn can store the staff replies that this one lost.
    return { replyText, marker: taken, staffReadFailed: false, staffWriteFailed: true };
  }
  return { replyText, marker: taken, staffReadFailed: false, staffWriteFailed: false };
}
