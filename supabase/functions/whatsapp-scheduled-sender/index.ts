import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { logSendRefused as writeSendRefused, optedOutPhones as lookupOptedOutPhones } from "../_shared/optOutLookup.ts";
import { handleScheduledSender, type DueScheduledMessage, type ScheduledSenderDeps } from "./handler.ts";

function scheduledDeps(): ScheduledSenderDeps {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return {
    authorize: verifyCronAuth,
    async loadDue(nowIso) {
      const { data, error } = await admin
        .from("whatsapp_scheduled_messages")
        .select("*, social_accounts:social_account_id(platform_user_id, access_token)")
        .eq("status", "pending")
        .lte("scheduled_at", nowIso)
        .limit(50);
      if (error) {
        console.error("[scheduled-sender] Query error");
        return { error: "scheduled_query_failed" };
      }
      return { messages: (data ?? []) as DueScheduledMessage[] };
    },
    optedOutPhones(userId, phones) {
      return lookupOptedOutPhones(admin, userId, phones);
    },
    logSendRefused(input) {
      return writeSendRefused(admin, input);
    },
    async updateMessage(id, patch) {
      const { error } = await admin.from("whatsapp_scheduled_messages").update(patch).eq("id", id);
      if (error) throw new Error("scheduled_message_update_failed");
    },
    async insertOutbound(row) {
      await admin.from("whatsapp_messages").insert(row);
    },
    async postGraph(url, token, payload) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json();
      return { data };
    },
    envToken() {
      return Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    },
    now() {
      return new Date();
    },
  };
}

Deno.serve((req) => handleScheduledSender(req, scheduledDeps()));
