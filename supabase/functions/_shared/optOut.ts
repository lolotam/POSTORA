// Inbound opt-out (Spec B §8.11). It stops business-initiated sends: pending store
// events, an active event-origin procedure, and agent replies that have not been
// claimed yet. A customer's own message, including one that arrives later, is
// re-engagement and is still answered. A failed opt-out write is logged, not swallowed.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2";
import { persistProcedureState } from "../ai-agent-reply/procedureState.ts";

const PHRASES = new Set([
  "stop",
  "unsubscribe",
  "stop messaging",
  "don't message me",
  "dont message me",
  "توقف",
  "الغاء الاشتراك",
  "لا ترسل",
]);

function normalize(text: string): string {
  return text.trim().toLowerCase().replace(/[أإآٱ]/g, "ا").replace(/’/g, "'");
}

/** Whole trimmed message, case-insensitive, with Arabic alef and hamza folded. */
export function isOptOutMessage(text: string): boolean {
  return PHRASES.has(normalize(text));
}

/**
 * Decided before the inbound row is stored. An owner echo is never an opt-out.
 * Recording comes before persist so a provider retry can still write the row.
 * The customer's message is still enqueued: opt-out does not gate the agent,
 * auto-replies, or n8n. It only stops business-initiated work already queued.
 */
export function inboundOptOutPlan(text: string, fromOwner = false): {
  recordBeforePersist: boolean;
  enqueueAgentReply: boolean;
  steps: readonly ("record_opt_out" | "persist_inbound" | "enqueue_agent_reply")[];
} {
  const recordBeforePersist = !fromOwner && isOptOutMessage(text);
  return {
    recordBeforePersist,
    enqueueAgentReply: true,
    steps: recordBeforePersist
      ? ["record_opt_out", "persist_inbound", "enqueue_agent_reply"]
      : ["persist_inbound", "enqueue_agent_reply"],
  };
}

/** Which step a warning describes. Never a phone number or a secret. */
export type OptOutWarnPhase = "upsert" | "skip" | "clear" | "cancel";

export interface OptOutDb {
  upsertOptOut(userId: string, phone: string): Promise<void>;
  skipEvents(socialAccountId: string, phone: string): Promise<void>;
  clearEventProcedure(userId: string, conversationId: string): Promise<void>;
  /**
   * Cancels this conversation's `pending_agent_replies` rows whose status is
   * still `pending` (not yet claimed). `running`, `sending`, and every later
   * status stay as they are.
   */
  cancelUnclaimedReplies(socialAccountId: string, conversationId: string): Promise<void>;
  warn(userId: string, socialAccountId: string, phase: OptOutWarnPhase): Promise<void>;
}

/**
 * Writes the opt-out, then best-effort follow-ups.
 *
 * Returns false only when the `messaging_opt_outs` upsert itself failed. That
 * row is the durable fact: the caller must not persist the inbound message,
 * and must answer the provider with a non-2xx so the delivery is retried.
 * `skipEvents`, `clearEventProcedure`, and `cancelUnclaimedReplies` failures
 * are logged and do not change the result — the opt-out row is already stored,
 * and those steps can be recovered without asking the provider to send the
 * message again.
 */
export async function recordOptOut(
  db: OptOutDb,
  input: { userId: string; socialAccountId: string; phone: string; conversationId: string },
): Promise<boolean> {
  try {
    await db.upsertOptOut(input.userId, input.phone);
  } catch {
    await warnOptOut(db, input, "upsert");
    return false;
  }
  try {
    await db.skipEvents(input.socialAccountId, input.phone);
  } catch {
    await warnOptOut(db, input, "skip");
  }
  try {
    await db.clearEventProcedure(input.userId, input.conversationId);
  } catch {
    await warnOptOut(db, input, "clear");
  }
  try {
    await db.cancelUnclaimedReplies(input.socialAccountId, input.conversationId);
  } catch {
    await warnOptOut(db, input, "cancel");
  }
  return true;
}

async function warnOptOut(
  db: OptOutDb,
  input: { userId: string; socialAccountId: string },
  phase: OptOutWarnPhase,
): Promise<void> {
  try {
    await db.warn(input.userId, input.socialAccountId, phase);
  } catch {
    // The warning is best-effort. A failed upsert still returns false.
  }
}

/**
 * A false result from `recordOptOut` means the opt-out row was not written.
 * Persisting would consume the provider redelivery, so the webhook answers
 * 500 and leaves the message unstored. True persists; the HTTP status here
 * is not a promise that the rest of the request succeeds.
 */
export function optOutPersistDecision(recorded: boolean): { persist: boolean; status: 200 | 500 } {
  return recorded ? { persist: true, status: 200 } : { persist: false, status: 500 };
}

/** The service-role client of either WhatsApp webhook. */
export function optOutDb(admin: SupabaseClient): OptOutDb {
  return {
    async upsertOptOut(userId, phone) {
      const { error } = await admin.from("messaging_opt_outs").upsert(
        { user_id: userId, phone, source: "whatsapp" },
        { onConflict: "user_id,phone" },
      );
      if (error) throw new Error("opt_out_upsert_failed");
    },
    async skipEvents(socialAccountId, phone) {
      const { error } = await admin.from("store_events").update({ status: "skipped", skip_reason: "opted_out" })
        .eq("social_account_id", socialAccountId)
        .filter("payload->>phone", "eq", phone)
        .in("status", ["pending", "claimed"]);
      if (error) throw new Error("opt_out_skip_failed");
    },
    async clearEventProcedure(userId, conversationId) {
      const { data, error } = await admin.from("ai_threads").select("id, procedure_state")
        .eq("user_id", userId).eq("platform", "whatsapp").eq("conversation_id", conversationId).maybeSingle();
      if (error) throw new Error("opt_out_state_read_failed");
      const state = data?.procedure_state as { origin?: string } | null;
      if (!data || !state || state.origin !== "event") return;
      const cleared = await persistProcedureState(admin, data.id, state, null);
      if (!cleared) throw new Error("opt_out_state_clear_failed");
    },
    async cancelUnclaimedReplies(socialAccountId, conversationId) {
      // `pending` is the only status before takeOutboxRow claims the row
      // (`pending` -> `running`). `sending` is a delivery already in flight.
      const { error } = await admin.from("pending_agent_replies")
        .update({ status: "cancelled", error: "opted_out", lease_expires_at: null })
        .eq("social_account_id", socialAccountId)
        .eq("conversation_id", conversationId)
        .eq("status", "pending");
      if (error) throw new Error("opt_out_cancel_failed");
    },
    async warn(userId, socialAccountId, phase) {
      const message = phase === "upsert"
        ? "Opt-out could not be recorded"
        : phase === "skip"
          ? "Opt-out was recorded but store events could not be skipped"
          : phase === "clear"
            ? "Opt-out was recorded but the event procedure could not be cleared"
            : "Opt-out was recorded but unclaimed replies could not be cancelled";
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "messaging",
        source: "opt-out",
        message,
        user_id: userId,
        metadata: { social_account_id: socialAccountId, phase },
      });
      if (error) throw new Error("opt_out_log_failed");
    },
  };
}
