import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { kickBackgroundJobsWorker } from "../_shared/backgroundJobs.ts";
import { handleWhatsAppBroadcast, type BroadcastDeps } from "./handler.ts";

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
        .maybeSingle();
      if (error) throw new Error(`load broadcast: ${error.message}`);
      return data ?? null;
    },
    async loadWhatsAppAccounts(userId) {
      const { data, error } = await admin
        .from("social_accounts")
        .select("platform_user_id, access_token, account_metadata")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .order("connected_at", { ascending: false });
      if (error) throw new Error(`load accounts: ${error.message}`);
      return data ?? [];
    },
    async hasPendingRecipients(broadcastId) {
      const { data, error } = await admin
        .from("whatsapp_broadcast_recipients")
        .select("id")
        .eq("broadcast_id", broadcastId)
        .eq("status", "pending")
        .limit(1);
      if (error) return null;
      return (data ?? []).length > 0;
    },
    async startBroadcast(userId, broadcastId) {
      const { data, error } = await admin.rpc("start_whatsapp_broadcast", {
        p_user_id: userId,
        p_broadcast_id: broadcastId,
      });
      if (error) throw new Error(`start broadcast: ${error.message}`);
      return typeof data === "string" ? data : null;
    },
    async logRecipientReadFailure(userId, broadcastId) {
      const { error } = await admin.from("system_logs").insert({
        level: "error",
        category: "system",
        source: "whatsapp-broadcast",
        message: "Broadcast refused: recipient read failed",
        user_id: userId,
        metadata: { broadcast_id: broadcastId, reason: "recipient_read_failed" },
      });
      if (error) throw new Error("Could not record broadcast refusal");
    },
    kickWorker() {
      return kickBackgroundJobsWorker(fetch, supabaseUrl, serviceRoleKey);
    },
  };
}

Deno.serve((req) => handleWhatsAppBroadcast(req, broadcastDeps()));
