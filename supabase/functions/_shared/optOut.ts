// Inbound opt-out (Spec B §8.11). Both WhatsApp webhooks record it and then stop every
// automation path (n8n, auto-replies, the agent). A failed write is logged, not swallowed.
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

/** An opt-out inbound message must not reach n8n, auto-replies, or the agent. */
export function automationAllowedAfterInbound(input: { optedOut: boolean }): boolean {
  return !input.optedOut;
}

/**
 * Decided before the inbound row is stored and before any agent reply is enqueued.
 * An owner echo is never an opt-out. When `recordBeforePersist` is set, the steps
 * are record then persist, and enqueue is absent.
 */
export function inboundOptOutPlan(text: string, fromOwner = false): {
  recordBeforePersist: boolean;
  enqueueAgentReply: boolean;
  steps: readonly ("record_opt_out" | "persist_inbound" | "enqueue_agent_reply")[];
} {
  const recordBeforePersist = !fromOwner && isOptOutMessage(text);
  const enqueueAgentReply = automationAllowedAfterInbound({ optedOut: recordBeforePersist });
  return {
    recordBeforePersist,
    enqueueAgentReply,
    steps: recordBeforePersist
      ? ["record_opt_out", "persist_inbound"]
      : ["persist_inbound", "enqueue_agent_reply"],
  };
}

export interface OptOutDb {
  upsertOptOut(userId: string, phone: string): Promise<void>;
  skipEvents(socialAccountId: string, phone: string): Promise<void>;
  clearEventProcedure(userId: string, conversationId: string): Promise<void>;
  warn(userId: string, socialAccountId: string): Promise<void>;
}

export async function recordOptOut(
  db: OptOutDb,
  input: { userId: string; socialAccountId: string; phone: string; conversationId: string },
): Promise<boolean> {
  try {
    await db.upsertOptOut(input.userId, input.phone);
    await db.skipEvents(input.socialAccountId, input.phone);
    await db.clearEventProcedure(input.userId, input.conversationId);
    return true;
  } catch {
    try {
      await db.warn(input.userId, input.socialAccountId);
    } catch {
      // The warning is best-effort; the caller still sees the failure.
    }
    return false;
  }
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
    async warn(userId, socialAccountId) {
      const { error } = await admin.from("system_logs").insert({
        level: "warn",
        category: "messaging",
        source: "opt-out",
        message: "Opt-out could not be recorded",
        user_id: userId,
        metadata: { social_account_id: socialAccountId },
      });
      if (error) throw new Error("opt_out_log_failed");
    },
  };
}
