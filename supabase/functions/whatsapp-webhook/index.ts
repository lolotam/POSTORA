import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Anti-loop: track last auto-reply time per conversation
const lastAutoReplyMap = new Map<string, number>();
const AUTO_REPLY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

function constantTimeEqual(left: string, right: string): boolean {
  const leftBytes = new TextEncoder().encode(left);
  const rightBytes = new TextEncoder().encode(right);
  const length = Math.max(leftBytes.length, rightBytes.length);
  let difference = leftBytes.length ^ rightBytes.length;

  for (let index = 0; index < length; index += 1) {
    difference |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
  }

  return difference === 0;
}

async function hasValidMetaSignature(rawBody: string, signature: string, secret: string): Promise<boolean> {
  try {
    const encoder = new TextEncoder();
    const key = await crypto.subtle.importKey(
      "raw",
      encoder.encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const digest = await crypto.subtle.sign("HMAC", key, encoder.encode(rawBody));
    const hexDigest = Array.from(new Uint8Array(digest))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

    return constantTimeEqual(signature, `sha256=${hexDigest}`);
  } catch {
    return false;
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  const url = new URL(req.url);

  // GET: Meta webhook verification challenge
  if (req.method === "GET") {
    const mode = url.searchParams.get("hub.mode");
    const token = url.searchParams.get("hub.verify_token");
    const challenge = url.searchParams.get("hub.challenge");
    const verifyToken = Deno.env.get("WHATSAPP_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[whatsapp-webhook] Verification successful");
      return new Response(challenge, { status: 200 });
    }
    console.warn("[whatsapp-webhook] Verification failed - token mismatch");
    return new Response("Forbidden", { status: 403 });
  }

  // POST: Incoming webhook events from Meta
  if (req.method === "POST") {
    const appSecret = Deno.env.get("WHATSAPP_APP_SECRET") ||
      Deno.env.get("META_APP_SECRET") ||
      Deno.env.get("FACEBOOK_APP_SECRET");
    const signature = req.headers.get("x-hub-signature-256");

    if (!appSecret || !signature) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    const rawBody = await req.text();
    if (!(await hasValidMetaSignature(rawBody, signature, appSecret))) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }

    try {
      const body = JSON.parse(rawBody);
      console.log("[whatsapp-webhook] Received verified event");

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseKey);

      const entries = body?.entry || [];
      for (const entry of entries) {
        const changes = entry?.changes || [];
        for (const change of changes) {
          if (change.field !== "messages") continue;

          const value = change.value;
          const phoneNumberId = value?.metadata?.phone_number_id;
          const displayPhone = value?.metadata?.display_phone_number;

          // Find the social account up front: embedded-signup accounts carry
          // their own access token, needed for media resolution and auto-replies.
          const { data: accounts } = await adminClient
            .from("social_accounts")
            .select("id, user_id, access_token")
            .eq("platform", "whatsapp")
            .eq("platform_user_id", phoneNumberId)
            .eq("is_active", true)
            .limit(1);
          const account = accounts?.[0] ?? null;
          const accessToken: string | null =
            account?.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN") || null;

          // Process incoming messages
          const messages = value?.messages || [];
          for (const msg of messages) {
            if (!account) {
              console.warn("[whatsapp-webhook] No matching account found");
              break;
            }

            const from = msg.from;
            const msgType = msg.type;
            const timestamp = msg.timestamp;
            const messageId = msg.id;

            let messageText = "";
            let mediaUrl: string | null = null;
            let inboundMediaType: string | null = null;
            let mediaMetadata: Record<string, unknown> | null = null;

            if (msgType === "text") {
              messageText = msg.text?.body || "";
            } else if (msgType === "image") {
              messageText = msg.image?.caption || `[Image]`;
              inboundMediaType = "image";
              mediaMetadata = { mime_type: msg.image?.mime_type, sha256: msg.image?.sha256, media_id: msg.image?.id };
              // Resolve media URL from Meta
              mediaUrl = await resolveMediaUrl(msg.image?.id, accessToken);
            } else if (msgType === "video") {
              messageText = msg.video?.caption || `[Video]`;
              inboundMediaType = "video";
              mediaMetadata = { mime_type: msg.video?.mime_type, sha256: msg.video?.sha256, media_id: msg.video?.id };
              mediaUrl = await resolveMediaUrl(msg.video?.id, accessToken);
            } else if (msgType === "document") {
              messageText = `[Document] ${msg.document?.filename || ""}`;
              inboundMediaType = "document";
              mediaMetadata = { mime_type: msg.document?.mime_type, sha256: msg.document?.sha256, filename: msg.document?.filename, media_id: msg.document?.id };
              mediaUrl = await resolveMediaUrl(msg.document?.id, accessToken);
            } else if (msgType === "audio") {
              messageText = "[Audio message]";
              inboundMediaType = "audio";
              mediaMetadata = { mime_type: msg.audio?.mime_type, media_id: msg.audio?.id };
              mediaUrl = await resolveMediaUrl(msg.audio?.id, accessToken);
            } else if (msgType === "sticker") {
              messageText = "[Sticker]";
              inboundMediaType = "sticker";
              mediaMetadata = { mime_type: msg.sticker?.mime_type, media_id: msg.sticker?.id };
              mediaUrl = await resolveMediaUrl(msg.sticker?.id, accessToken);
            } else if (msgType === "location") {
              messageText = `[Location] ${msg.location?.latitude}, ${msg.location?.longitude}`;
            } else if (msgType === "contacts") {
              messageText = `[Contact] ${msg.contacts?.[0]?.name?.formatted_name || ""}`;
            } else if (msgType === "interactive") {
              messageText = msg.interactive?.button_reply?.title || msg.interactive?.list_reply?.title || "[Interactive]";
            } else if (msgType === "reaction") {
              messageText = `[Reaction] ${msg.reaction?.emoji || ""}`;
            } else {
              messageText = `[${msgType}]`;
            }

            const conversationId = `wa_${phoneNumberId}_${from}`;

            const contacts = value?.contacts || [];
            const contactName = contacts.find((c: any) => c.wa_id === from)?.profile?.name || from;
            const msgTimestamp = new Date(parseInt(timestamp) * 1000).toISOString();

            // Store individual message with media info
            await adminClient.from("whatsapp_messages").insert({
              user_id: account.user_id,
              social_account_id: account.id,
              conversation_id: conversationId,
              message_id: messageId,
              from_phone: from,
              from_name: contactName,
              to_phone: displayPhone,
              message_text: messageText,
              message_type: msgType,
              media_url: mediaUrl,
              media_type: inboundMediaType,
              media_metadata: mediaMetadata,
              direction: "inbound",
              status: "received",
              timestamp: msgTimestamp,
            });

            // Upsert messaging_cache, incrementing the unread counter
            const { data: cachedConversation } = await adminClient
              .from("messaging_cache")
              .select("unread_count")
              .eq("user_id", account.user_id)
              .eq("conversation_id", conversationId)
              .maybeSingle();

            await adminClient
              .from("messaging_cache")
              .upsert({
                user_id: account.user_id,
                social_account_id: account.id,
                conversation_id: conversationId,
                platform: "whatsapp",
                participant_name: contactName,
                participant_avatar: null,
                last_message_preview: messageText.slice(0, 200),
                last_message_at: msgTimestamp,
                unread_count: (cachedConversation?.unread_count || 0) + 1,
                updated_at: new Date().toISOString(),
              }, {
                onConflict: "user_id,conversation_id",
              });

            console.log("[whatsapp-webhook] Stored inbound message");

            // === AUTO-REPLY LOGIC ===
            await processAutoReplies(adminClient, account, conversationId, phoneNumberId, from, messageText, accessToken);

            // === EXTERNAL WEBHOOK DISPATCH (fire-and-forget) ===
            dispatchToWebhooks(adminClient, account.user_id, {
              event: "message.received",
              timestamp: msgTimestamp,
              data: {
                from,
                contact_name: contactName,
                message: messageText,
                message_type: msgType,
                conversation_id: conversationId,
                phone_number_id: phoneNumberId,
              },
            }).catch(() => console.error("[whatsapp-webhook] Webhook dispatch failed"));
          }

          // Process status updates — write back to whatsapp_messages and surface failures
          const statuses = value?.statuses || [];
          for (const status of statuses) {
            const wamid: string | undefined = status.id;
            const newStatus: string = status.status; // sent | delivered | read | failed
            const errObj = Array.isArray(status.errors) && status.errors.length ? status.errors[0] : null;
            const errorCode: string | null = errObj ? String(errObj.code ?? "") : null;
            const rawErrorMessage: string | null = errObj?.message || errObj?.title || null;

            // Friendly mapping for common codes
            let friendlyError = rawErrorMessage;
            if (errorCode === "131047") {
              friendlyError = "Recipient hasn't messaged you in the last 24h — send an approved Template Message instead.";
            } else if (errorCode === "131026") {
              friendlyError = "Message undeliverable — recipient may not have WhatsApp.";
            } else if (errorCode === "131051") {
              friendlyError = "Unsupported message type for this recipient.";
            }

            console.log(`[whatsapp-webhook] Received ${newStatus} status update`);

            if (!wamid) continue;

            // Update the original message row
            const updatePayload: Record<string, unknown> = { status: newStatus };
            if (errorCode) updatePayload.error_code = errorCode;
            if (friendlyError) updatePayload.error_message = friendlyError;

            const { data: updatedRows } = await adminClient
              .from("whatsapp_messages")
              .update(updatePayload)
              .eq("message_id", wamid)
              .select("conversation_id, user_id, social_account_id, message_text");

            // On failure, mark the conversation preview with a warning
            if (newStatus === "failed" && updatedRows && updatedRows.length > 0) {
              const row = updatedRows[0] as {
                conversation_id: string;
                user_id: string;
                social_account_id: string;
                message_text: string | null;
              };
              const warnPreview = `⚠️ ${row.message_text || "(send failed)"}`.slice(0, 200);
              await adminClient
                .from("messaging_cache")
                .update({
                  last_message_preview: warnPreview,
                  updated_at: new Date().toISOString(),
                })
                .eq("user_id", row.user_id)
                .eq("conversation_id", row.conversation_id);
            }
          }
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch {
      console.error("[whatsapp-webhook] Webhook processing failed");
      return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

async function processAutoReplies(
  adminClient: any,
  account: { id: string; user_id: string },
  conversationId: string,
  phoneNumberId: string,
  recipientPhone: string,
  inboundText: string,
  accessToken: string | null
) {
  try {
    // Check cooldown
    const lastReply = lastAutoReplyMap.get(conversationId);
    if (lastReply && Date.now() - lastReply < AUTO_REPLY_COOLDOWN_MS) {
      console.log("[whatsapp-webhook] Auto-reply cooldown active");
      return;
    }

    // Fetch active auto-reply rules for this user
    const { data: rules, error } = await adminClient
      .from("whatsapp_auto_replies")
      .select("*")
      .eq("user_id", account.user_id)
      .eq("is_active", true);

    if (error || !rules || rules.length === 0) return;

    const now = new Date();
    const currentDay = now.getDay(); // 0=Sun
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM

    let matchedReply: string | null = null;
    let matchedRuleId: string | null = null;

    // Check away rules first
    for (const rule of rules) {
      if (rule.rule_type !== "away") continue;
      
      if (rule.schedule_days && !rule.schedule_days.includes(currentDay)) continue;
      
      if (rule.schedule_start && rule.schedule_end) {
        const start = rule.schedule_start.slice(0, 5);
        const end = rule.schedule_end.slice(0, 5);
        
        if (start <= end) {
          if (currentTime < start || currentTime > end) continue;
        } else {
          if (currentTime < start && currentTime > end) continue;
        }
      }
      
      matchedReply = rule.reply_message;
      matchedRuleId = rule.id;
      console.log("[whatsapp-webhook] Away rule matched");
      break;
    }

    // If no away rule matched, check keyword rules
    if (!matchedReply) {
      const lowerText = inboundText.toLowerCase();
      for (const rule of rules) {
        if (rule.rule_type !== "keyword" || !rule.keywords) continue;
        const matched = rule.keywords.some((kw: string) => lowerText.includes(kw.toLowerCase()));
        if (matched) {
          matchedReply = rule.reply_message;
          matchedRuleId = rule.id;
          console.log("[whatsapp-webhook] Keyword rule matched");
          break;
        }
      }
    }

    if (!matchedReply) return;

    // Send auto-reply via WhatsApp Cloud API using the account's own token
    // (env WHATSAPP_ACCESS_TOKEN fallback happens at the call site)
    if (!accessToken) {
      console.error("[whatsapp-webhook] No access token for this account and WHATSAPP_ACCESS_TOKEN not set, cannot send auto-reply");
      return;
    }

    const sendRes = await fetch(
      `https://graph.facebook.com/v21.0/${phoneNumberId}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          messaging_product: "whatsapp",
          to: recipientPhone,
          type: "text",
          text: { body: matchedReply },
        }),
      }
    );

    const sendData = await sendRes.json();
    console.log("[whatsapp-webhook] Auto-reply request completed");

    if (sendRes.ok) {
      // Store outbound auto-reply in whatsapp_messages
      const outboundMsgId = sendData?.messages?.[0]?.id || `auto_${Date.now()}`;
      await adminClient.from("whatsapp_messages").insert({
        user_id: account.user_id,
        social_account_id: account.id,
        conversation_id: conversationId,
        message_id: outboundMsgId,
        from_phone: phoneNumberId,
        from_name: "Auto-Reply",
        to_phone: recipientPhone,
        message_text: matchedReply,
        message_type: "text",
        direction: "outbound",
        status: "sent",
        timestamp: new Date().toISOString(),
      });

      // Update cooldown
      lastAutoReplyMap.set(conversationId, Date.now());

      // Log auto-reply usage for analytics
      if (matchedRuleId) {
        await adminClient.from("whatsapp_auto_reply_usage").insert({
          user_id: account.user_id,
          auto_reply_rule_id: matchedRuleId,
          conversation_id: conversationId,
        }).then(() => {
          console.log(`[whatsapp-webhook] Auto-reply usage logged for rule ${matchedRuleId}`);
        }).catch((e: any) => {
          console.warn("[whatsapp-webhook] Failed to log auto-reply usage:", e);
        });
      }
    }
  } catch {
    console.error("[whatsapp-webhook] Auto-reply failed");
  }
}

async function dispatchToWebhooks(
  adminClient: any,
  userId: string,
  payload: Record<string, any>
) {
  const { data: webhooks } = await adminClient
    .from("whatsapp_webhooks")
    .select("id, url, secret, events, failure_count")
    .eq("user_id", userId)
    .eq("is_active", true);

  if (!webhooks || webhooks.length === 0) return;

  const body = JSON.stringify(payload);

  for (const wh of webhooks) {
    // Check if this webhook subscribes to the event
    if (wh.events && !wh.events.includes(payload.event)) continue;

    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };

      // HMAC-SHA256 signing
      if (wh.secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey(
          "raw", encoder.encode(wh.secret),
          { name: "HMAC", hash: "SHA-256" }, false, ["sign"]
        );
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(body));
        headers["X-Webhook-Signature"] = Array.from(new Uint8Array(sig))
          .map(b => b.toString(16).padStart(2, "0")).join("");
      }

      const res = await fetch(wh.url, { method: "POST", headers, body });
      const statusCode = res.status;

      if (res.ok) {
        await adminClient.from("whatsapp_webhooks").update({
          last_triggered_at: new Date().toISOString(),
          last_status_code: statusCode,
          failure_count: 0,
        }).eq("id", wh.id);
      } else {
        const newFailures = (wh.failure_count || 0) + 1;
        await adminClient.from("whatsapp_webhooks").update({
          last_triggered_at: new Date().toISOString(),
          last_status_code: statusCode,
          failure_count: newFailures,
          is_active: newFailures < 10,
        }).eq("id", wh.id);
        console.warn(`[whatsapp-webhook] Webhook ${wh.id} failed with HTTP ${statusCode} (failures: ${newFailures})`);
      }
    } catch (err) {
      const newFailures = (wh.failure_count || 0) + 1;
      await adminClient.from("whatsapp_webhooks").update({
        failure_count: newFailures,
        is_active: newFailures < 10,
      }).eq("id", wh.id);
      console.error(`[whatsapp-webhook] Webhook ${wh.id} dispatch error:`, err);
    }
  }
}

async function resolveMediaUrl(mediaId: string | undefined, token: string | null): Promise<string | null> {
  if (!mediaId || !token) return null;
  try {
    const res = await fetch(`https://graph.facebook.com/v22.0/${mediaId}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.url || null;
  } catch {
    return null;
  }
}
