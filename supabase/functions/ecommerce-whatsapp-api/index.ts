import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { logSendRefused as writeSendRefused, optedOutPhones as lookupOptedOutPhones } from "../_shared/optOutLookup.ts";
import { resolveWhatsAppTransport, type WhatsAppTransportAccount } from "../_shared/whatsappTransport.ts";
import { handleEcommerceWhatsApp, type EcommerceAccount, type EcommerceDeps } from "./handler.ts";

const GRAPH_API = "https://graph.facebook.com/v22.0";

function transportAccount(account: EcommerceAccount): WhatsAppTransportAccount {
  if (!account.platform_user_id) throw new Error("missing_phone_number_id");
  const mode = account.connection_mode;
  return {
    id: account.id,
    platform_user_id: account.platform_user_id,
    access_token: account.access_token,
    connection_mode: mode === "cloud_api" || mode === "coexistence" || mode === "evolution_qr" ? mode : null,
    account_metadata: account.account_metadata,
  };
}

function ecommerceDeps(): EcommerceDeps {
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  return {
    async lookupUser(apiKeyHash) {
      const { data } = await admin.from("profiles").select("id").eq("api_key_hash", apiKeyHash).maybeSingle();
      return data ? { id: data.id as string } : null;
    },
    async recentPostCount(userId, sinceIso) {
      const { count } = await admin
        .from("api_logs")
        .select("*", { count: "exact", head: true })
        .eq("user_id", userId)
        .eq("endpoint", "/ecommerce-whatsapp-api")
        .gte("created_at", sinceIso);
      return count ?? 0;
    },
    async insertApiLog(row) {
      await admin.from("api_logs").insert(row);
    },
    async loadHealth(userId) {
      const { data } = await admin
        .from("social_accounts")
        .select("id, platform_username, account_metadata, is_active, platform_user_id, access_token, connection_mode")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .maybeSingle();
      return data as EcommerceAccount | null;
    },
    async loadSendAccount(userId, explicitAccountId) {
      let query = admin
        .from("social_accounts")
        .select("id, platform, platform_user_id, access_token, connection_mode, account_metadata, is_active")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true);
      if (explicitAccountId) query = query.eq("id", explicitAccountId);
      const { data } = await query.maybeSingle();
      return data as EcommerceAccount | null;
    },
    optedOutPhones(userId, phones) {
      return lookupOptedOutPhones(admin, userId, phones);
    },
    logSendRefused(input) {
      return writeSendRefused(admin, input);
    },
    async sendText(account, to, text) {
      const transport = await resolveWhatsAppTransport(admin, transportAccount(account));
      return (await transport.sendText({ recipientPhone: to, text })).raw;
    },
    async sendMedia(account, input) {
      const transport = await resolveWhatsAppTransport(admin, transportAccount(account));
      return (await transport.sendMedia({
        recipientPhone: input.to,
        mediaUrl: input.mediaUrl,
        mediaType: input.mediaType,
        caption: input.caption,
        fileName: input.fileName,
      })).raw;
    },
    async postGraph(phoneNumberId, token, payload) {
      const res = await fetch(`${GRAPH_API}/${phoneNumberId}/messages`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload),
      });
      const data = await res.json().catch(() => ({}));
      return { ok: res.ok, data };
    },
    async insertMessage(row) {
      await admin.from("whatsapp_messages").insert(row);
    },
    now() {
      return Date.now();
    },
  };
}

Deno.serve((req) => handleEcommerceWhatsApp(req, ecommerceDeps()));
