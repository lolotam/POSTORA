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
  lateStaffTurns,
  staffTurnsSince,
  type MessageRow,
  type ReplyLanguage,
  type StoredTurn,
  withOpening,
} from "./logic.ts";
import {
  ReplyNotPersistedError,
  peekStoredReply,
  replaceStoredReply,
  settleOutboxRow,
  type ReplyEscalation,
  type StoredReplyRow,
} from "./outbox.ts";

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
  /**
   * The window could not be read, so its state is unknown.
   *
   * A failed read is NOT an absent window: the marker may well be set, and the apology
   * and the staff context that go with it are still owed. A turn that read it may not
   * answer as if the customer had never waited.
   */
  readFailed: boolean;
}

export const NO_AFTERMATH: EscalationAftermath = {
  since: null,
  staffReplies: 0,
  staffTurns: [],
  readFailed: false,
};

/**
 * What the aftermath settlement did, so the caller can put the marker back when the
 * reply it belonged to never became durable.
 */
export interface AftermathSettlement {
  /** The reply to send, with the apology already opened when one was owed. */
  replyText: string;
  /** The marker this turn leased, when it leased one. */
  marker: string | null;
  /**
   * The lease token this turn holds on that marker.
   *
   * The marker alone does not say WHICH lease is being acted on: two workers that leased
   * the same marker hold the same marker. The token is what a stale worker is refused
   * on, so it travels with the reply to the statement that writes it.
   */
  claimToken: string | null;
  /** The window could not be read, so the marker has to come back. */
  staffReadFailed: boolean;
  /** The staff context could not be stored, so the marker has to come back. */
  staffWriteFailed: boolean;
  /**
   * The window's state could not be read at all.
   *
   * Unlike a staff read that failed -- where the marker is known and only its context is
   * missing -- nothing here says whether a window is owed. The reply may therefore not go
   * out as if the customer had never waited: the caller fails the turn and the outbox
   * retries it, so the apology and the staff context are still owed.
   */
  windowReadFailed: boolean;
  /**
   * The staff sends that arrived while the model was answering.
   *
   * The answer was written against a context that did not have them, so it may
   * repeat or contradict what the customer has just read from the staff. The caller
   * writes the answer again with them in mind, or sends nothing at all.
   */
  lateStaffTurns: StoredTurn[];
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
      body: { ok: false, error: "the customer's turn could not be stored" },
      cancelWorkItem: false,
    };
  }

  // Terminal for the work item: a closed gate is a decision, and recovery re-driving
  // the row would only reach the same gate.
  if (input.outboxId) {
    const settled = await settleOutboxRow(input.admin, input.outboxId, input.gateReason, input.turn.userId);
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
 * A FAILED read is none of those cases: the row's state is unknown, so the notice's
 * claim is not taken and nothing is settled. The outbox retries, and the row is read
 * again.
 *
 * The claim decides what may be settled with the row:
 *
 *   * "claimed" is this turn's notice to deliver;
 *   * "window" is another worker's notice, in whatever state it is in. The row is left
 *     alone: it may be the row that worker is about to persist the notice into, and
 *     cancelling it would take the notice away from it;
 *   * "delivered" and "none" with a row that holds the notice mean the notice never
 *     went out. It is delivered from the row, because a durable notice that is
 *     cancelled is a promise the customer never hears.
 *
 * The claim is taken AFTER the row is classified, so the claim is only ever spent on a
 * notice this turn is going to deliver, and it is a LEASE: a turn that dies before the
 * notice is durable hands it back after the lease lapses.
 *
 * A CLOSED service window stops all of it: the notice is a free-form message, and the
 * provider refuses one outside the window. No notice is attempted there, and the
 * acknowledgement is not completed for a notice that was never sent.
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
  /**
   * Whether WhatsApp delivery is still allowed for this conversation.
   *
   * The human_first gate takes precedence over the service window, so a closed
   * window is turned into the one-time notice. A notice is a free-form message,
   * and outside the service window the provider refuses one: the notice may
   * therefore not be attempted there.
   */
  serviceWindowOpen: boolean;
}): Promise<ClosedGateDecision> {
  const peeked = input.outboxId
    ? await peekStoredReply(input.admin, input.outboxId)
    : { outcome: "read" as const, status: null, text: null, kind: null };
  if (peeked.outcome === "read_failed") {
    // The row's state is unknown. The notice's claim is NOT taken: a claim spent on a
    // row nobody could read is a claim spent on nothing, and settling the row here
    // would cancel the very answer that may still be in it.
    return { kind: "retryable", error: "the stored reply could not be read" };
  }

  // A durable notice must survive a closed provider window. No new claim is needed
  // until delivery reopens, and cancellation would erase the only remaining promise.
  if (!input.serviceWindowOpen && peeked.kind === "human_mode_ack" && peeked.text !== null) {
    return { kind: "retryable", error: "the persisted notice is waiting for the service window" };
  }

  const claim = await claimHumanModeAck(input.admin, input.scope, {
    gateReason: input.gateReason,
    isComment: input.isComment,
  });

  if (claim.result === "failed") {
    // The claim's state is unknown, so nothing may be settled on the strength of it: the
    // work item stays unsettled, and the customer's question is not lost over a hiccup.
    return { kind: "retryable", error: "the human-mode acknowledgement claim could not be read" };
  }

  if (!input.serviceWindowOpen) {
    // The service window is closed, so the provider refuses a free-form message: no
    // notice is attempted. The acknowledgement is therefore not completed for a notice
    // that was never sent, and the claim this turn took goes back so that a later turn
    // -- one whose window is open again -- can still deliver the notice the customer
    // is owed. The row is settled like any other closed gate.
    if (claim.result === "claimed" && claim.claimToken) {
      const released = await releaseHumanModeAck(input.admin, input.scope, claim.claimToken);
      if (!released) {
        // The claim was not this turn's to release. The lease still stands, so a later
        // turn takes it over once it lapses -- the notice is not lost, but it waits.
        console.warn("[ai-agent-reply] the human-mode acknowledgement claim was not released");
      }
    }
    // The window the claim reports is the one this turn belongs to, so the customer's
    // question is kept on the record: nobody answered it.
    return await settleUnderClosedGate(input, claim.result === "claimed" ? "window" : claim.result);
  }

  if (claim.result === "claimed") {
    return await noticeUnderClaim(input, claim.claimToken, peeked);
  }

  if (claim.result === "window") {
    // Another worker holds the notice's claim, and it is taking, persisting or sending
    // the notice. The row is left alone whatever it holds: cancelling it would take the
    // notice away from that worker, and the notice would be owed to nobody. The work
    // item stays unsettled, so the outbox tries again once the lease has lapsed or the
    // notice has gone out.
    return { kind: "retryable", error: "the human-mode notice is being delivered by another turn" };
  }

  if (peeked.kind === "human_mode_ack" && peeked.text !== null) {
    // The row holds the notice the customer was promised, and the notice never went
    // out. It is delivered from the row, exactly as it was persisted: settling the row
    // here would swallow it for good and the customer would never learn that a human
    // has their conversation.
    //
    // "delivered" is the worker that persisted the notice dying between the completion
    // and the send. "none" is the bounded window expiring before the notice could be
    // recovered -- the promise outlives the window, so the notice is still owed.
    return { kind: "notice", text: peeked.text, fromRow: true, claimToken: null };
  }

  // Nothing is owed here: the window was notified already, the notice was delivered, or
  // there is no bounded window at all. The stored answer is settled under this gate so
  // it can never be delivered later, and the customer's turn is kept.
  return await settleUnderClosedGate(input, claim.result);
}

/**
 * The notice, for the turn that holds the claim.
 *
 * The claim is only ever spent on a notice this turn is going to deliver, so the row's
 * contents decide which notice that is.
 */
async function noticeUnderClaim(
  input: {
    admin: SupabaseClient;
    scope: HandoffScope;
    outboxId: string | null;
    gateReason: string;
    language: ReplyLanguage;
    threadId: string;
    turn: { userId: string; content: string; id?: string };
  },
  claimToken: string | null,
  row: StoredReplyRow,
): Promise<ClosedGateDecision> {
  const notice = HUMAN_MODE_ACK[input.language];
  if (row.kind === "human_mode_ack" && row.text !== null) {
    // The notice was persisted by an earlier attempt. Deliver that text, not a new
    // one: this is the promise the customer was given.
    return { kind: "notice", text: row.text, fromRow: true, claimToken };
  }
  if (row.text !== null && input.outboxId) {
    // The row holds an answer written while the gate was open. The notice takes its
    // place in the row: the row stays the durable record of what the customer is owed.
    //
    // The claim it spends is spent by the SAME statement. A notice that is durable
    // with its claim still owed is a notice a later turn takes the expired lease over
    // and sends again -- the customer is told twice that a human has their
    // conversation.
    if (!claimToken) {
      // The claim was taken but carries no token, so this caller cannot spend it. The
      // notice is not written: a notice without the claim it spends is a notice that
      // may be sent twice. The work item stays unsettled, and a later turn retries it.
      return { kind: "retryable", error: "the acknowledgement claim carries no token" };
    }
    const replaced = await replaceStoredReply(
      input.admin,
      input.outboxId,
      {
        text: notice,
        kind: "human_mode_ack",
      },
      {
        userId: input.scope.userId,
        platform: input.scope.platform,
        conversationId: input.scope.conversationId,
        claimToken,
      },
      input.turn.userId,
    );
    if (!replaced) {
      return { kind: "retryable", error: "the stored answer could not be replaced by the notice" };
    }
    return { kind: "notice", text: notice, fromRow: true, claimToken };
  }
  if (!rowTakesNotice(row.status)) {
    // The row is past the point where a notice could be stored: a send was already
    // attempted, or the work item is terminal. The notice is not written into a row
    // that cannot carry it, and it is not sent from a row that may already have it.
    return await settleUnderClosedGate(input, "claimed");
  }
  return { kind: "notice", text: notice, fromRow: false, claimToken };
}

/**
 * Whether a notice can still be written into the row.
 *
 * A `pending` row is taken into `running` and the notice persisted into it; a `running`
 * row has the notice persisted into it directly. Every other state is past the point
 * where a notice could be stored: `ready_to_send` holds the text that is delivered from
 * it (and is handled above), and `sending`, `sent` and `delivery_unknown` may already
 * have gone out.
 */
function rowTakesNotice(status: string | null): boolean {
  return status === null || status === "pending" || status === "running";
}

/**
 * Settles the work item under a closed gate, with the window the claim reported.
 */
async function settleUnderClosedGate(
  input: {
    admin: SupabaseClient;
    outboxId: string | null;
    gateReason: string;
    threadId: string;
    turn: { userId: string; content: string; id?: string };
  },
  claimResult: AckClaimResult,
): Promise<ClosedGateDecision> {
  const settlement = await settleClosedGate({
    admin: input.admin,
    outboxId: input.outboxId,
    gateReason: input.gateReason,
    humanWindow: claimResult === "window" || claimResult === "delivered" ? "window" : "none",
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
 *
 * A claim that could not be read is "failed", never "absent": the marker may still be
 * set, and the window it belongs to is still owed.
 *
 * The claim comes with a TOKEN: the lease stamp it was taken with. Two workers that
 * leased the same marker hold the same marker, so the marker alone cannot say which
 * lease a release or a completion is about. The token can, and every takeover writes a
 * new one, so a worker that outlived its lease is refused instead of acting on the
 * lease that replaced it.
 */
export async function claimUnansweredEscalation(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
): Promise<{ marker: string | null; token: string | null; claimed: boolean; failed: boolean }> {
  const { data, error } = await admin.rpc("claim_unanswered_escalation", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_lease_seconds: ESCALATION_CLAIM_LEASE_SECONDS,
  });
  if (error) {
    console.error("[ai-agent-reply] unanswered-escalation claim failed:", error.message);
    // The claim could not be read, so the window's state is unknown: the marker may
    // still be set. This is NOT an absent window, and the caller is told so.
    return { marker: null, token: null, claimed: false, failed: true };
  }
  const claim = (data ?? {}) as { marker?: unknown; token?: unknown };
  const marker = typeof claim.marker === "string" ? claim.marker : null;
  const token = typeof claim.token === "string" ? claim.token : null;
  if (marker === null && token === null) {
    // No marker, or the marker is leased by a live claim: there is nothing to act on,
    // and that much is known.
    return { marker: null, token: null, claimed: false, failed: false };
  }
  if (marker === null || token === null) {
    // A lease nobody can name: the marker alone would let a stale worker release the
    // claim that replaced it. The state cannot be read, so it is not read as "no
    // marker" either.
    console.error("[ai-agent-reply] unanswered-escalation claim returned an unreadable lease");
    return { marker: null, token: null, claimed: false, failed: true };
  }
  return { marker, token, claimed: true, failed: false };
}

/**
 * Consumes the escalation marker: the reply it belonged to became durable, so the
 * window is resolved and no later turn apologises for it.
 *
 * The marker AND the lease have to be the ones this turn holds, so a stale completion
 * can never clear a marker a newer window set -- nor the lease a newer worker is
 * working under.
 */
export async function completeUnansweredEscalation(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
  since: string,
  claimToken: string | null,
): Promise<boolean> {
  if (!claimToken) return false;
  const { data, error } = await admin.rpc("complete_unanswered_escalation", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_since: since,
    p_claim_token: claimToken,
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
 * back is what lets a later turn claim it. Only the lease this caller holds is
 * given back: a worker that was overtaken cannot free the lease its replacement is
 * working under. A marker that is already set to a different value is newer than this
 * one and is left alone: overwriting it would lose that window and its staff replies.
 */
export async function releaseUnansweredEscalationClaim(
  admin: SupabaseClient,
  scope: HandoffScope,
  threadId: string,
  since: string,
  claimToken: string | null,
): Promise<boolean> {
  if (!claimToken) return false;
  const { data, error } = await admin.rpc("release_unanswered_escalation_claim", {
    p_thread_id: threadId,
    p_user_id: scope.userId,
    p_since: since,
    p_claim_token: claimToken,
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
    // The id is what makes the same staff send stored once, and the media
    // columns are what an attachment-only send is recognised by.
    .select("id, direction, from_name, message_text, message_type, media_url, created_at")
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
 * upsert is what writes the marker.
 *
 * A failed read is NOT an absent window. The marker may well be set, and the apology and
 * the staff context that go with it are still owed, so the failure is reported as one:
 * the caller may not answer as if the customer had never waited.
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
    return { since: null, staffReplies: 0, staffTurns: [], readFailed: true };
  }
  const since = marked?.unanswered_escalation_since;
  if (typeof since !== "string") return NO_AFTERMATH;
  const staff = await readStaffReplies(admin, scope, since);
  if (staff.failed) {
    // The window is known, its staff context is not. Claiming a delay staff may in fact
    // have answered is worse than omitting the apology -- but the window is still owed,
    // so the failure is reported instead of being read as "no window".
    return { since, staffReplies: 0, staffTurns: [], readFailed: true };
  }

  return { since, staffReplies: staff.rows.length, staffTurns: staffTurnsSince(staff.rows, since), readFailed: false };
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
 *
 * A window whose state could not be read at all is reported as such: the caller may not
 * answer as if the customer had never waited, so the turn fails and is retried instead.
 */
export async function settleEscalationAftermath(
  admin: SupabaseClient,
  context: {
    scope: HandoffScope; threadId: string; language: ReplyLanguage;
    claim?: Awaited<ReturnType<typeof claimUnansweredEscalation>>;
  },
  aftermath: EscalationAftermath,
  replyText: string,
): Promise<AftermathSettlement> {
  if (aftermath.readFailed) {
    // The window's state is unknown: the marker may be set, and the apology and the
    // staff context that go with it are still owed. Nothing is claimed about it, and the
    // reply is not allowed to go out as if the customer had never waited.
    return {
      replyText,
      marker: null,
      claimToken: null,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: true,
      lateStaffTurns: [],
    };
  }
  if (aftermath.since === null) {
    return {
      replyText,
      marker: null,
      claimToken: null,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: false,
      lateStaffTurns: [],
    };
  }
  const claim = context.claim ?? await claimUnansweredEscalation(admin, context.scope, context.threadId);
  if (claim.failed) {
    // The claim could not be read: the marker may still be set, so the window is still
    // owed. It is not read as an absent window.
    return {
      replyText,
      marker: null,
      claimToken: null,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: true,
      lateStaffTurns: [],
    };
  }
  if (!claim.claimed || claim.marker === null || claim.token === null) {
    // No marker, or another worker holds the lease on it: that worker is making the
    // apology, and this turn's reply says nothing about the window.
    return {
      replyText,
      marker: null,
      claimToken: null,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: false,
      lateStaffTurns: [],
    };
  }
  const taken = claim.marker;
  const token = claim.token;

  const staff = await readStaffReplies(admin, context.scope, taken);
  if (staff.failed) {
    // The window could not be read, so nothing is claimed about it: no apology
    // (staff may have answered) and no staff turns to store. The lease goes back,
    // so the next turn reads the window again instead of finding it consumed.
    return {
      replyText,
      marker: taken,
      claimToken: token,
      staffReadFailed: true,
      staffWriteFailed: false,
      windowReadFailed: false,
      lateStaffTurns: [],
    };
  }
  const apology = escalationApologyText(taken, staff.rows.length, context.language);
  if (apology) {
    return {
      replyText: withOpening(replyText, apology),
      marker: taken,
      claimToken: token,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: false,
      lateStaffTurns: [],
    };
  }
  if (!staff.rows.length) {
    return {
      replyText,
      marker: taken,
      claimToken: token,
      staffReadFailed: false,
      staffWriteFailed: false,
      windowReadFailed: false,
      lateStaffTurns: [],
    };
  }

  // The staff sends that arrived while the model was answering. The answer was
  // written without them, so it may repeat or contradict what the customer has
  // just read from the staff.
  const late = lateStaffTurns(staff.rows, aftermath.staffTurns, taken);

  const { error: staffWriteError } = await admin.from("ai_thread_messages").upsert(
    staffTurnsSince(staff.rows, taken).map((turn) => ({
      // The id of the message the turn replays. The staff turns are written
      // BEFORE the reply they belong to, so a reply that never became durable
      // leaves them behind and the next attempt writes them again: with the
      // message's own id the second write is refused as a duplicate, and the
      // thread keeps ONE copy of each staff send instead of a pile of them
      // that pushes the customer's own messages out of the bounded history.
      ...(turn.source_id ? { id: turn.source_id } : {}),
      thread_id: context.threadId,
      user_id: context.scope.userId,
      role: turn.role,
      content: turn.content,
      created_at: turn.created_at,
    })),
    { onConflict: "id", ignoreDuplicates: true },
  );
  if (staffWriteError) {
    console.error("[ai-agent-reply] staff turn write failed:", staffWriteError.message);
    // The staff context is still owed to the thread. The marker carries it, so the
    // lease goes back and the next turn can store the staff replies that this one lost.
    return {
      replyText,
      marker: taken,
      claimToken: token,
      staffReadFailed: false,
      staffWriteFailed: true,
      windowReadFailed: false,
      lateStaffTurns: late,
    };
  }
  return {
    replyText,
    marker: taken,
    claimToken: token,
    staffReadFailed: false,
    staffWriteFailed: false,
    windowReadFailed: false,
    lateStaffTurns: late,
  };
}

/**
 * The escalation window this reply resolves, or null when it resolves none.
 *
 * A staff context that could not be read or stored resolves NOTHING: the marker is what
 * carries that context, so the lease goes back and a later turn stores the staff replies
 * this one lost. Consuming the marker here would drop them for good.
 *
 * A window whose state could not be read resolves nothing either: there is no marker to
 * name, and the window may still be owed.
 *
 * Set, the marker is consumed by the SAME statement that writes the reply, so a worker
 * killed between the two cannot leave the apology owed a second time. The lease token
 * travels with it: the marker alone cannot say which lease is being consumed, and a
 * worker whose lease lapsed must not store another apology against the lease that
 * replaced it.
 */
export function escalationForReply(
  settlement: AftermathSettlement,
  scope: { threadId: string; userId: string },
): ReplyEscalation | null {
  if (!settlement.marker) return null;
  if (settlement.staffWriteFailed || settlement.staffReadFailed) return null;
  if (settlement.windowReadFailed) return null;
  if (!settlement.claimToken) return null;
  return {
    threadId: scope.threadId,
    userId: scope.userId,
    since: settlement.marker,
    claimToken: settlement.claimToken,
  };
}
