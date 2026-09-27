import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { logSendRefused as writeSendRefused, optedOutPhones as lookupOptedOutPhones } from "../_shared/optOutLookup.ts";
import { resolveWhatsAppTransport } from "../_shared/whatsappTransport.ts";
import { handleScheduledSender, type ClaimedScheduledMessage, type ScheduledSenderDeps } from "./handler.ts";

// The edge worker is killed near 60 s; budget + one send timeout stay under it.
const BUDGET_MS = 30_000;
const SEND_TIMEOUT_MS = 15_000;
const CLAIM_LIMIT = 25;
const CLAIM_LEASE = "5 minutes";
const UNSAFE_METADATA_KEY = /phone|token|secret|authorization|api[_-]?key|password|message_text|caption/i;

function safeMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (UNSAFE_METADATA_KEY.test(key)) continue;
    safe[key] = value;
  }
  return safe;
}

function scheduledDeps(): ScheduledSenderDeps {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return {
    authorize: verifyCronAuth,
    async loadDue() {
      const { data, error } = await admin.rpc("claim_whatsapp_scheduled_messages", {
        p_limit: CLAIM_LIMIT,
        p_lease: CLAIM_LEASE,
      });
      if (error) {
        console.error("[scheduled-sender] claim failed");
        return { error: "scheduled_query_failed" };
      }
      const rows = Array.isArray(data) ? data : [];
      return { messages: rows as ClaimedScheduledMessage[] };
    },
    optedOutPhones(userId, phones) {
      return lookupOptedOutPhones(admin, userId, phones);
    },
    logSendRefused(input) {
      return writeSendRefused(admin, input);
    },
    async logEvent(entry) {
      const { error } = await admin.from("system_logs").insert({
        level: entry.level,
        category: "system",
        source: "whatsapp-scheduled-sender",
        message: entry.message.slice(0, 300),
        user_id: entry.userId,
        metadata: safeMetadata(entry.metadata),
      });
      if (error) console.error("[scheduled-sender] log insert failed");
    },
    async transition(input) {
      const { data, error } = await admin
        .from("whatsapp_scheduled_messages")
        .update(input.patch)
        .eq("id", input.id)
        .eq("claim_token", input.claimToken)
        .eq("status", input.expectedStatus)
        .select("id");
      if (error) throw new Error("scheduled_message_update_failed");
      return Array.isArray(data) && data.length > 0;
    },
    async insertOutbound(row) {
      const { error } = await admin.from("whatsapp_messages").insert(row);
      if (error) throw new Error("whatsapp_message_insert_failed");
    },
    resolveTransport(account) {
      return resolveWhatsAppTransport(admin, account);
    },
    now() {
      return new Date();
    },
    budgetMs: BUDGET_MS,
    sendTimeoutMs: SEND_TIMEOUT_MS,
  };
}

Deno.serve((req) => handleScheduledSender(req, scheduledDeps()));
