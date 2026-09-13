// The floor that runs when every model in the chain failed. Its own module because
// index.ts starts a server at import time and tools.ts would close an import cycle.
import { modelOutageApology, type ReplyLanguage } from "./logic.ts";
import { escalateConversation, type EscalationOutcome, type EscalationTarget } from "./tools.ts";

/** Only what the floor needs. index.ts's ReplyRequest satisfies this structurally. */
export interface OutageRequest {
  comment_id?: string;
  recipient_phone: string;
}

/** Matches index.ts's TextSender without importing it. */
export type OutageSender = (recipientId: string, text: string) => Promise<string>;

export interface OutageFloorResult {
  apology_sent: boolean;
  escalated: boolean;
  human_notified: boolean;
}

/** Of the floor's reserve, this much is for the escalation; the rest protects the send. */
const ESCALATION_BUDGET_MS = 7_000;

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Last resort when every model in the chain failed. Without it the customer's
 * message is dropped in silence: the catch below returns HTTP 200 and all four
 * callers are fire-and-forget, so nothing downstream notices.
 *
 * Escalation runs BEFORE the apology, and the apology is conditional on it. The
 * mode flip inside escalateConversation is what gates the AI for this
 * conversation (shouldAiReply rejects human_first, logic.ts:99), so doing it
 * first stops the customer's next message producing a second apology. Apologising
 * first and failing the mode write would repeat the apology on every later
 * message, and would promise a human who had not been told.
 *
 * muteRegardless: an assistant whose every model failed must not keep answering,
 * whatever the account default. The mute is bounded by the account's escalation
 * timeout, and the apology suppression holds for that window.
 *
 * Each step swallows its own errors on purpose: this runs inside a catch, so a
 * throw here would replace a reported model outage with an unrelated error.
 */
export async function deliverModelOutageFloor(
  request: OutageRequest,
  sender: OutageSender | null,
  replyLanguage: ReplyLanguage,
  target: EscalationTarget | null,
  prior: { escalated: boolean; humanNotified: boolean },
): Promise<OutageFloorResult> {
  let outcome: EscalationOutcome | null = null;
  if (!prior.escalated && target) {
    try {
      // Bounded so the escalation cannot eat the whole reserve and leave nothing
      // for the customer send. escalateConversation always completes the mode
      // upsert; only the assignment and the admin notifications yield to it.
      outcome = await escalateConversation(
        { ...target, muteRegardless: true },
        "All configured AI models failed",
        Date.now() + ESCALATION_BUDGET_MS,
      );
    } catch (escalationError) {
      console.error("[ai-agent-reply] Outage escalation failed:", message(escalationError));
    }
    // A manual override (ai_first or human_then_ai, no expiry) is the operator's
    // and is never rewritten, so the escalation can return without a mute. An
    // apology then would repeat on every message; treat it like a failed
    // escalation (Codex P2, PR #178).
    if (outcome && !outcome.muted) {
      console.error(
        `[ai-agent-reply] Outage escalation left the conversation unmuted (mode ${outcome.mode}, manual override); no apology sent`,
      );
      outcome = null;
    }
  }

  // Nothing muted the conversation, so an apology now would repeat on every
  // subsequent message. Silence is the lesser failure; the caller logs this as
  // model_exhaustion_unhandled so it is visible rather than merely quiet.
  const escalated = prior.escalated || outcome !== null;
  if (!escalated) return { apology_sent: false, escalated: false, human_notified: false };

  // Only a proven contact licenses the "someone has been notified" wording.
  // escalate_to_human returns escalated: true even when no agent was online and
  // admin_phone_numbers was empty, so the tool's own outcome has to be carried
  // here rather than inferred from the fact that it ran.
  const humanNotified = prior.escalated
    ? prior.humanNotified
    : Boolean(outcome && (outcome.assigned || outcome.adminsNotified > 0));

  let apologySent = false;
  // A public comment gets no apology. "We're having trouble" posted under a
  // customer's comment is readable by everyone and reads worse than silence.
  if (!request.comment_id && sender) {
    try {
      await sender(request.recipient_phone, modelOutageApology(replyLanguage, humanNotified));
      apologySent = true;
    } catch (sendError) {
      console.error("[ai-agent-reply] Outage apology send failed:", message(sendError));
    }
  }

  return { apology_sent: apologySent, escalated: true, human_notified: humanNotified };
}
