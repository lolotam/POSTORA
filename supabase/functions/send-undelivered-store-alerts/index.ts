// Cron entrypoint for the undelivered store-orders alert. Modelled on
// send-token-expiry-notifications: cron auth first, Resend + a service-role client
// as the deps implementation, and every PostgREST result checked explicitly.

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { Resend } from "https://esm.sh/resend@2.0.0";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { restrictedCorsHeaders } from "../_shared/cors.ts";
import { sendAlerts, type SendAlertsDeps, type UndeliveredAccountRow } from "./handler.ts";

// Same sender as send-token-expiry-notifications.
const FROM_SENDER = "Postora <notifications@postora.cloud>";

Deno.serve(async (req) => {
  const corsHeaders = restrictedCorsHeaders(req);
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  try {
    const resendApiKey = Deno.env.get("RESEND_API_KEY");
    if (!resendApiKey) {
      console.error("[send-undelivered-store-alerts] RESEND_API_KEY not configured");
      return new Response(
        JSON.stringify({ error: "email not configured" }),
        { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const resend = new Resend(resendApiKey);
    const admin = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const deps: SendAlertsDeps = {
      async listFlagged() {
        const { data, error } = await admin
          .from("social_accounts")
          .select("id, user_id, platform, platform_username, alerts_snoozed, account_metadata")
          .eq("platform", "whatsapp")
          .not("account_metadata->undelivered_store_events", "is", null);
        if (error) throw error;
        return (data ?? []) as UndeliveredAccountRow[];
      },
      async loadProfile(userId) {
        const { data, error } = await admin
          .from("profiles")
          .select("email, full_name, email_notifications_enabled")
          .eq("id", userId)
          .maybeSingle();
        if (error) throw error;
        return data ?? null;
      },
      async claim(accountId, since) {
        const { data, error } = await admin.rpc("claim_undelivered_alert_email", {
          p_account_id: accountId,
          p_since: since,
        });
        if (error) throw error;
        return data === true;
      },
      async send(payload) {
        const { error } = await resend.emails.send({
          from: FROM_SENDER,
          to: [payload.to],
          subject: payload.subject,
          html: payload.html,
        });
        if (error) throw new Error(error.message);
      },
      async mark(accountId, since) {
        const { data, error } = await admin.rpc("mark_undelivered_alert_emailed", {
          p_account_id: accountId,
          p_since: since,
        });
        if (error) throw error;
        return data === true;
      },
      now: () => new Date(),
    };

    const summary = await sendAlerts(deps);
    return new Response(
      JSON.stringify({ ok: true, ...summary }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  } catch (error) {
    // Raw database/provider errors stay in the log; the response is generic.
    console.error(
      "[send-undelivered-store-alerts] run failed:",
      error instanceof Error ? error.message : String(error),
    );
    return new Response(
      JSON.stringify({ error: "alert run failed" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } },
    );
  }
});
