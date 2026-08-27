// The rules for what recovery does with a work item whose lease lapsed.
//
// Pure, so it can be tested as a table. A sibling of index.ts because that file is a
// Deno.serve module and importing it starts a server.
//
// Design: docs/superpowers/plans/2026-08-27-durable-reply-outbox.md, Task 5.

export const RECOVERY_LIMITS = {
  /** Longer than the 60s worker ceiling, so a lease never lapses while its holder is alive. */
  leaseSeconds: 180,
  maxAttempts: 3,
  /** The whole run must fit under the worker ceiling with room for the final bookkeeping. */
  budgetMs: 50_000,
  /**
   * A row is only claimed when this much of the budget remains, because claiming charges an
   * attempt. A row that re-runs media understanding and the agent can take ~50s, so this is
   * effectively one row per run when the work is slow and two when it is quick. Slow but
   * honest: every incremented attempt is work that genuinely began.
   */
  perRowMs: 40_000,
} as const;

/** WhatsApp and Messenger both close the customer-service window 24h after the last inbound. */
export const SEND_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RecoveryRow {
  id: string;
  status: string;
  generated_reply: string | null;
  inbound_at: string;
  comment_id: string | null;
}

/**
 * What the job can cheaply learn about the conversation before acting. These are a
 * pre-filter, not the authority: ai-agent-reply re-runs its own gates (mode, human
 * assignment, cap, cooldown) on every invocation, redeliveries included, and a gate that
 * closes there settles the row as cancelled.
 */
export interface RecoveryContext {
  humanTookOver: boolean;
  newerPendingInConversation: boolean;
  outsideSendWindow: boolean;
}

export type RecoveryAction =
  /** Nothing external has happened: re-invoke the agent from scratch. */
  | { kind: "rerun_agent" }
  /** Text exists and no delivery was attempted: deliver it, regenerate nothing. */
  | { kind: "deliver_stored" }
  /** A tool or escalation MAY have fired and nothing can tell: a person decides. */
  | { kind: "hand_to_human" }
  /** A delivery attempt was in flight and may have reached the customer: never re-send. */
  | { kind: "delivery_unknown" }
  /** Not worth attempting, and nothing was sent. */
  | { kind: "cancel"; reason: string };

/**
 * The lapsed state decides first, and the conversation's situation second.
 *
 * The order matters. A row found in `sending` is ambiguous whatever the conversation has
 * since done -- a human taking over does not make a possibly-delivered message undelivered
 * -- so those two states are settled before any context is consulted.
 */
export function decideRecovery(row: RecoveryRow, context: RecoveryContext): RecoveryAction {
  if (row.status === "sending") return { kind: "delivery_unknown" };
  if (row.status === "running") return { kind: "hand_to_human" };

  if (context.humanTookOver) return { kind: "cancel", reason: "human_took_over" };
  if (context.newerPendingInConversation) return { kind: "cancel", reason: "superseded" };
  if (context.outsideSendWindow) return { kind: "cancel", reason: "outside_send_window" };

  if (row.status === "ready_to_send" && typeof row.generated_reply === "string") {
    return { kind: "deliver_stored" };
  }
  if (row.status === "pending") return { kind: "rerun_agent" };

  // ready_to_send with no text cannot be produced by advance_agent_reply, and a terminal
  // status is never claimed. Reaching here means the table holds something this code did
  // not write; a person should look rather than the job guessing.
  return { kind: "hand_to_human" };
}

/**
 * Whether the platform would still accept a message for this inbound.
 *
 * Per surface: a public comment reply has no window, so `comment_id` exempts the row. For
 * DMs the window is measured from the customer's message, which is what the platform
 * measures it from -- persisting a reply does not extend it.
 */
export function isOutsideSendWindow(row: Pick<RecoveryRow, "inbound_at" | "comment_id">, now: number): boolean {
  if (row.comment_id) return false;
  return now - new Date(row.inbound_at).getTime() > SEND_WINDOW_MS;
}

/** Whether a run has enough budget left to start one more row. */
export function canStartAnotherRow(elapsedMs: number, limits = RECOVERY_LIMITS): boolean {
  return elapsedMs + limits.perRowMs <= limits.budgetMs;
}
