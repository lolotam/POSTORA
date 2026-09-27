import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { logSendRefused as writeSendRefused, optedOutPhones as lookupOptedOutPhones } from "../_shared/optOutLookup.ts";
import { handleWhatsAppBroadcast, type BroadcastDeps } from "./handler.ts";
import { markRecipientsSkipped } from "./optOut.ts";

function broadcastDeps(): BroadcastDeps {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(supabaseUrl, serviceRoleKey);

  return {
    async authenticate(req) {
      const authHeader = req.headers.get("Authorization");
      if (!authHeader) {
        return {
          response: new Response(JSON.stringify({ error: "Not authenticated" }), {
            status: 401,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
              "Content-Type": "application/json",
            },
          }),
        };
      }
      const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
        global: { headers: { Authorization: authHeader } },
      });
      const { data: { user }, error } = await supabaseUser.auth.getUser();
      if (error || !user) {
        return {
          response: new Response(JSON.stringify({ error: "Invalid token" }), {
            status: 401,
            headers: {
              "Access-Control-Allow-Origin": "*",
              "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
              "Content-Type": "application/json",
            },
          }),
        };
      }
      return { userId: user.id };
    },
    async loadBroadcast(userId, broadcastId) {
      const { data, error } = await admin
        .from("whatsapp_broadcasts")
        .select("id, status, name, template_name, template_components, sent_count, failed_count")
        .eq("id", broadcastId)
        .eq("user_id", userId)
        .single();
      if (error || !data) return null;
      return data;
    },
    async loadWhatsAppAccounts(userId) {
      const { data } = await admin
        .from("social_accounts")
        .select("platform_user_id, access_token, account_metadata")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      return data ?? [];
    },
    async loadPendingRecipients(broadcastId) {
      const { data, error } = await admin
        .from("whatsapp_broadcast_recipients")
        .select("id, phone_number")
        .eq("broadcast_id", broadcastId)
        .eq("status", "pending");
      if (error) return null;
      return data ?? [];
    },
    async markSending(broadcastId) {
      await admin.from("whatsapp_broadcasts").update({ status: "sending" }).eq("id", broadcastId);
    },
    skipRecipients(broadcastId, ids) {
      return markRecipientsSkipped(admin, broadcastId, ids);
    },
    async markRecipientSent(id, sentAt) {
      await admin.from("whatsapp_broadcast_recipients").update({ status: "sent", sent_at: sentAt }).eq("id", id);
    },
    async markRecipientFailed(id, errorMessage) {
      await admin.from("whatsapp_broadcast_recipients").update({ status: "failed", error_message: errorMessage }).eq("id", id);
    },
    async insertOutbound(row) {
      await admin.from("whatsapp_messages").insert(row);
    },
    async finish(broadcastId, patch) {
      await admin.from("whatsapp_broadcasts").update(patch).eq("id", broadcastId);
    },
    optedOutPhones(userId, phones) {
      return lookupOptedOutPhones(admin, userId, phones);
    },
    logSendRefused(input) {
      return writeSendRefused(admin, input);
    },
    async postTemplate(phoneNumberId, accessToken, body) {
      const res = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      return { ok: res.ok, data };
    },
    sleep(ms) {
      return new Promise((resolve) => setTimeout(resolve, ms));
    },
  };
}

Deno.serve((req) => handleWhatsAppBroadcast(req, broadcastDeps()));
