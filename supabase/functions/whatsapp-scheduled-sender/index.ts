import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

const GRAPH_API = "https://graph.facebook.com/v22.0";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const adminClient = createClient(supabaseUrl, supabaseKey);

    // Fetch all pending messages that are due
    const { data: pendingMsgs, error } = await adminClient
      .from("whatsapp_scheduled_messages")
      .select("*, social_accounts:social_account_id(platform_user_id, access_token)")
      .eq("status", "pending")
      .lte("scheduled_at", new Date().toISOString())
      .limit(50);

    if (error) {
      console.error("[scheduled-sender] Query error:", error);
      return new Response(JSON.stringify({ error: error.message }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    if (!pendingMsgs || pendingMsgs.length === 0) {
      return new Response(JSON.stringify({ processed: 0 }), {
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const accessToken = Deno.env.get("WHATSAPP_ACCESS_TOKEN");
    let processed = 0;

    for (const msg of pendingMsgs) {
      try {
        const phoneNumberId = (msg as any).social_accounts?.platform_user_id;
        if (!phoneNumberId) {
          await adminClient.from("whatsapp_scheduled_messages").update({
            status: "failed",
            error_message: "Social account not found",
          }).eq("id", msg.id);
          continue;
        }

        // Multi-tenant: the account's own token first, shared env secret as fallback
        const token = (msg as any).social_accounts?.access_token || accessToken;
        if (!token) {
          await adminClient.from("whatsapp_scheduled_messages").update({
            status: "failed",
            error_message: "No access token available",
          }).eq("id", msg.id);
          continue;
        }

        const url = `${GRAPH_API}/${phoneNumberId}/messages`;
        let payload: any;

        if (msg.media_url && msg.media_type) {
          const mediaObj: any = { link: msg.media_url };
          if (msg.message_text) mediaObj.caption = msg.message_text;
          if (msg.media_type === "document") mediaObj.filename = msg.media_url.split("/").pop() || "file";
          payload = {
            messaging_product: "whatsapp",
            to: msg.recipient_phone,
            type: msg.media_type,
            [msg.media_type]: mediaObj,
          };
        } else {
          payload = {
            messaging_product: "whatsapp",
            to: msg.recipient_phone,
            type: "text",
            text: { body: msg.message_text || "" },
          };
        }

        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
          body: JSON.stringify(payload),
        });
        const data = await res.json();

        if (data.error) {
          await adminClient.from("whatsapp_scheduled_messages").update({
            status: "failed",
            error_message: data.error.message || JSON.stringify(data.error),
          }).eq("id", msg.id);
        } else {
          const sentMsgId = data.messages?.[0]?.id;
          await adminClient.from("whatsapp_scheduled_messages").update({
            status: "sent",
            sent_at: new Date().toISOString(),
          }).eq("id", msg.id);

          // Store in whatsapp_messages
          const normalizedPhone = msg.recipient_phone.replace(/^\+/, "");
          const conversationId = `wa_${phoneNumberId}_${normalizedPhone}`;
          await adminClient.from("whatsapp_messages").insert({
            user_id: msg.user_id,
            social_account_id: msg.social_account_id,
            conversation_id: conversationId,
            message_id: sentMsgId || `sched_${msg.id}`,
            from_phone: phoneNumberId,
            from_name: "You (Scheduled)",
            to_phone: msg.recipient_phone,
            message_text: msg.message_text || `[${msg.media_type || "scheduled"}]`,
            message_type: msg.media_type || "text",
            direction: "outbound",
            status: "sent",
            timestamp: new Date().toISOString(),
          });

          processed++;
        }
      } catch (err) {
        console.error(`[scheduled-sender] Error processing msg ${msg.id}:`, err);
        await adminClient.from("whatsapp_scheduled_messages").update({
          status: "failed",
          error_message: (err as Error).message || "Unknown error",
        }).eq("id", msg.id);
      }
    }

    console.log(`[scheduled-sender] Processed ${processed}/${pendingMsgs.length} messages`);
    return new Response(JSON.stringify({ processed, total: pendingMsgs.length }), {
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error("[scheduled-sender] Fatal error:", err);
    return new Response(JSON.stringify({ error: (err as Error).message }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
