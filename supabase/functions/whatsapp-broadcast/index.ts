import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { resolveWhatsAppCloudCredentials } from "../_shared/whatsappCloudCredentials.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // Verify auth
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(JSON.stringify({ error: "Not authenticated" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey);
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    const { data: { user }, error: authError } = await supabaseUser.auth.getUser();
    if (authError || !user) {
      return new Response(JSON.stringify({ error: "Invalid token" }), {
        status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const { broadcast_id } = await req.json();
    if (!broadcast_id) {
      return new Response(JSON.stringify({ error: "broadcast_id required" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Get broadcast (verify ownership)
    const { data: broadcast, error: bErr } = await supabaseAdmin
      .from("whatsapp_broadcasts")
      .select("*")
      .eq("id", broadcast_id)
      .eq("user_id", user.id)
      .single();

    if (bErr || !broadcast) {
      return new Response(JSON.stringify({ error: "Broadcast not found" }), {
        status: 404, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (broadcast.status !== "pending") {
      return new Response(JSON.stringify({ error: `Broadcast already ${broadcast.status}` }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Multi-tenant: send with the user's own connected WhatsApp account, and only that.
    // Broadcasts go out over the Cloud API, so Direct QR accounts cannot carry them; every
    // active account is considered rather than only the newest, which may well be a QR one.
    const { data: waAccounts } = await supabaseAdmin
      .from("social_accounts")
      .select("platform_user_id, access_token, account_metadata")
      .eq("user_id", user.id)
      .eq("platform", "whatsapp")
      .eq("is_active", true)
      .order("connected_at", { ascending: false });

    const resolution = resolveWhatsAppCloudCredentials(waAccounts || []);
    if (resolution.status !== "ok") {
      return new Response(
        JSON.stringify(
          resolution.status === "requires_cloud_api"
            ? {
              error: resolution.reason === "qr_only"
                ? "Broadcasts require a Cloud API connection. This number is connected with Direct QR, which cannot send template messages."
                : "This WhatsApp number is missing the Cloud API credentials needed to broadcast. Reconnect it from Setup.",
              code: "BROADCAST_REQUIRES_CLOUD_API",
            }
            : { error: "No connected WhatsApp Business account", code: "NO_WHATSAPP_ACCOUNT" },
        ),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
      );
    }

    const { accessToken: whatsappToken, phoneNumberId } = resolution.credentials;

    // Get recipients
    const { data: recipients, error: rErr } = await supabaseAdmin
      .from("whatsapp_broadcast_recipients")
      .select("*")
      .eq("broadcast_id", broadcast_id)
      .eq("status", "pending");

    if (rErr || !recipients?.length) {
      return new Response(JSON.stringify({ error: "No pending recipients" }), {
        status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    // Cap at 1000
    const batch = recipients.slice(0, 1000);

    // Mark broadcast as sending
    await supabaseAdmin
      .from("whatsapp_broadcasts")
      .update({ status: "sending" })
      .eq("id", broadcast_id);

    // Send messages with throttling
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of batch) {
      try {
        const messageBody: Record<string, unknown> = {
          messaging_product: "whatsapp",
          to: recipient.phone_number,
          type: "template",
          template: {
            name: broadcast.template_name,
            language: { code: broadcast.template_components?.language || "en_US" },
          },
        };

        // Add template components if provided
        if (broadcast.template_components?.body_parameters) {
          (messageBody.template as Record<string, unknown>).components = [
            {
              type: "body",
              parameters: broadcast.template_components.body_parameters.map((p: string) => ({
                type: "text",
                text: p,
              })),
            },
          ];
        }

        const res = await fetch(
          `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${whatsappToken}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify(messageBody),
          }
        );

        const resData = await res.json();

        if (res.ok && resData.messages?.[0]?.id) {
          await supabaseAdmin
            .from("whatsapp_broadcast_recipients")
            .update({ status: "sent", sent_at: new Date().toISOString() })
            .eq("id", recipient.id);

          // Store in whatsapp_messages for conversation visibility
          const normalizedPhone = recipient.phone_number.replace(/\D/g, "");
          const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;

          await supabaseAdmin.from("whatsapp_messages").insert({
            user_id: user.id,
            conversation_id: conversationId,
            direction: "outbound",
            message_type: "template",
            content: `[Broadcast: ${broadcast.name}] Template: ${broadcast.template_name}`,
            wa_message_id: resData.messages[0].id,
            phone_number_id: phoneNumberId,
            contact_phone: recipient.phone_number,
            status: "sent",
          });

          sentCount++;
        } else {
          const errMsg = resData.error?.message || "Send failed";
          await supabaseAdmin
            .from("whatsapp_broadcast_recipients")
            .update({ status: "failed", error_message: errMsg })
            .eq("id", recipient.id);
          failedCount++;
        }
      } catch (e) {
        await supabaseAdmin
          .from("whatsapp_broadcast_recipients")
          .update({ status: "failed", error_message: (e as Error).message })
          .eq("id", recipient.id);
        failedCount++;
      }

      // Throttle: 100ms between messages
      await new Promise((r) => setTimeout(r, 100));
    }

    // Update broadcast counts and status
    const finalStatus = failedCount === batch.length ? "failed" : "completed";
    await supabaseAdmin
      .from("whatsapp_broadcasts")
      .update({
        status: finalStatus,
        sent_count: broadcast.sent_count + sentCount,
        failed_count: broadcast.failed_count + failedCount,
      })
      .eq("id", broadcast_id);

    return new Response(
      JSON.stringify({ success: true, sent: sentCount, failed: failedCount, status: finalStatus }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (e) {
    console.error("Broadcast error:", e);
    return new Response(JSON.stringify({ error: (e as Error).message }), {
      status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
