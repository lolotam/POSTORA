import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { resolveAutomationHandler } from "../_shared/automationHandler.ts";
import { getSendCredentials, type SocialAccountForMessaging } from "../_shared/messengerCredentials.ts";
import { buildMessagePayload, dispatchMessageEvent, shouldDispatchInboundMessage } from "../_shared/n8nMessagingDispatch.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Anti-loop: track last auto-reply time per conversation
const lastAutoReplyMap = new Map<string, number>();
const AUTO_REPLY_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const ACCOUNT_SELECT = "id, user_id, platform, platform_user_id, platform_username, ig_auth_type, account_metadata, access_token";

// Finds the social_accounts row for a webhook entry.id. Instagram Login issues two ids per
// account — an app-scoped one from /me?fields=id and the Instagram-scoped id (IGID) from
// /me?fields=user_id — and messaging webhooks address the account by its IGID. Connect
// stores the app-scoped id in platform_user_id/ig_user_id and the IGID in ig_igid, so all
// three are tried: platform_user_id covers Facebook pages and older Graph-linked Instagram
// accounts, ig_igid covers direct-login accounts, and ig_user_id stays as a fallback for
// rows connected before ig_igid existed.
async function findAccountForRecipient(
  adminClient: any,
  platform: "facebook" | "instagram",
  recipientId: string,
): Promise<SocialAccountForMessaging | null> {
  const { data: byPlatformUserId } = await adminClient
    .from("social_accounts")
    .select(ACCOUNT_SELECT)
    .eq("platform", platform)
    .eq("platform_user_id", recipientId)
    .eq("is_active", true)
    .limit(1);
  if (byPlatformUserId && byPlatformUserId.length > 0) return byPlatformUserId[0];

  if (platform !== "instagram") return null;

  for (const metadataKey of ["ig_igid", "ig_user_id"]) {
    const { data } = await adminClient
      .from("social_accounts")
      .select(ACCOUNT_SELECT)
      .eq("platform", "instagram")
      .eq("is_active", true)
      .eq(`account_metadata->>${metadataKey}`, recipientId)
      .limit(1);
    if (data && data.length > 0) return data[0];
  }
  return null;
}

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
    const verifyToken = Deno.env.get("META_MESSAGING_WEBHOOK_VERIFY_TOKEN");

    if (mode === "subscribe" && token === verifyToken) {
      console.log("[fb-ig-webhook] Verification successful");
      return new Response(challenge, { status: 200 });
    }
    console.warn("[fb-ig-webhook] Verification failed - token mismatch");
    return new Response("Forbidden", { status: 403 });
  }

  // POST: Incoming webhook events from Meta
  if (req.method === "POST") {
    const appSecret = Deno.env.get("FACEBOOK_APP_SECRET");
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
      const platform = body.object === "instagram" ? "instagram" : "facebook";
      console.log(`[fb-ig-webhook] Received verified ${platform} event`);

      const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
      const supabaseKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
      const adminClient = createClient(supabaseUrl, supabaseKey);

      const entries = body?.entry || [];
      for (const entry of entries) {
        const recipientId = entry.id;
        const events = entry?.messaging || [];
        let handledMessages = 0;

        for (const event of events) {
          // Only handle actual inbound messages, not delivery/read receipts or echoes of our own sends.
          if (!event.message || !shouldDispatchInboundMessage({ isEcho: event.message.is_echo })) continue;
          handledMessages += 1;

          const account = await findAccountForRecipient(adminClient, platform, recipientId);
          if (!account) {
            console.warn(`[fb-ig-webhook] No matching ${platform} account found for recipient ${recipientId}`);
            continue;
          }

          const senderId: string = event.sender?.id;
          const messageText: string = event.message.text || (event.message.attachments ? "[Attachment]" : "");

          // Keyed by this account's stable internal id rather than any Meta-supplied id: Meta
          // represents the same account/conversation with different external ids depending on
          // which API surface produced them (confirmed for direct-login Instagram accounts,
          // where the id inside conversation payloads differs from platform_user_id). The
          // internal id is the one thing both this webhook and list_conversations agree on.
          const conversationId = `${account.id}_${senderId}`;

          const inboxResult = await recordInboxEvent(adminClient, {
            account,
            platform,
            eventType: "message",
            externalEventId: event.message.mid || `${senderId}:${event.timestamp}`,
            payload: event,
          });

          const automationHandler = resolveAutomationHandler(account.account_metadata);

          // Dispatch stays tied to a successful insert, which is what makes the insert an
          // idempotency claim: Meta retries a failed delivery, and dispatching on error too
          // would run the user's workflow again when that retry finally persists. The
          // failure is logged instead, because it was previously indistinguishable from a
          // message that simply had nothing to dispatch.
          if (inboxResult === "error") {
            console.error(`[fb-ig-webhook] Inbox persist failed for ${platform}; automation not dispatched`);
          }
          if (inboxResult === "inserted" && automationHandler !== "off") {
            await runInBackground("facebook-instagram message dispatch", () => dispatchMessageEvent(
              adminClient,
              account.user_id,
              buildMessagePayload({
                platform,
                socialAccountId: account.id,
                account,
                conversationId,
                sender: {
                  id: senderId,
                  name: event.sender?.name || null,
                  phone: event.sender?.phone || null,
                },
                message: {
                  id: event.message.mid || `${senderId}:${event.timestamp}`,
                  text: messageText,
                  type: event.message.attachments ? "attachment" : "text",
                  attachments: event.message.attachments?.data || event.message.attachments || [],
                },
                timestamp: event.timestamp ? new Date(event.timestamp).toISOString() : undefined,
              }),
            ));
          }

          console.log(`[fb-ig-webhook] Received inbound ${platform} message`);

          const ruleReplied = automationHandler === "internal"
            ? await processAutoReplies(adminClient, account, platform, conversationId, senderId, messageText)
            : false;

          // Deterministic rules outrank the AI; only unclaimed messages reach
          // the agent. Echoes/receipts never get here (filtered above).
          if (automationHandler === "internal" && !ruleReplied) {
            triggerAiAgentReply(account, platform, conversationId, senderId, messageText)
              .catch((e) => console.error("[fb-ig-webhook] AI agent dispatch failed:", e?.message || e));
          }
        }

        for (const change of entry?.changes || []) {
          const account = await findAccountForRecipient(adminClient, platform, recipientId);
          const externalEventId = change?.value?.comment_id || change?.value?.id;
          if (account && externalEventId) {
            await recordInboxEvent(adminClient, {
              account,
              platform,
              eventType: "comment",
              externalEventId: String(externalEventId),
              payload: change,
            });
          }
        }

        // Meta delivering an event that yields no message is indistinguishable from Meta
        // not delivering at all, because every filter above continues silently. This
        // records the envelope shape -- never message content -- so a delivery that does
        // not become an inbox event can be told apart from one that never arrived.
        if (handledMessages === 0) {
          console.log(`[fb-ig-webhook] ${platform} entry produced no inbound message`, JSON.stringify({
            entryId: recipientId,
            entryKeys: Object.keys(entry || {}),
            messagingCount: events.length,
            messagingKinds: events.map((event: any) =>
              Object.keys(event || {}).filter((key) => key !== "sender" && key !== "recipient" && key !== "timestamp")
            ),
            changeFields: (entry?.changes || []).map((change: any) => change?.field),
          }));
        }
      }

      return new Response(JSON.stringify({ success: true }), {
        status: 200,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    } catch (err) {
      console.error("[fb-ig-webhook] Webhook processing failed:", err);
      return new Response(JSON.stringify({ error: "Webhook processing failed" }), {
        status: 500,
        headers: { ...corsHeaders, "Content-Type": "application/json" },
      });
    }
  }

  return new Response("Method not allowed", { status: 405 });
});

async function recordInboxEvent(
  adminClient: any,
  { account, platform, eventType, externalEventId, payload }: {
    account: SocialAccountForMessaging;
    platform: "facebook" | "instagram";
    eventType: "message" | "comment";
    externalEventId: string;
    payload: unknown;
  },
): Promise<"inserted" | "duplicate" | "error"> {
  const { data, error } = await adminClient.from("social_inbox_events").upsert({
    user_id: account.user_id,
    social_account_id: account.id,
    platform,
    event_type: eventType,
    external_event_id: externalEventId,
    payload,
  }, { onConflict: "social_account_id,external_event_id", ignoreDuplicates: true }).select("id");
  if (error) {
    console.error("[fb-ig-webhook] Failed to persist inbox event", error.message);
    return "error";
  }
  return data?.length ? "inserted" : "duplicate";
}

// Returns true when auto-reply rules own this message (a rule matched, or a
// rule replied recently and the anti-spam cooldown is active), so the AI
// agent should stay silent. Returns false when no rule claimed the message.
async function processAutoReplies(
  adminClient: any,
  account: SocialAccountForMessaging,
  platform: "facebook" | "instagram",
  conversationId: string,
  recipientId: string,
  inboundText: string,
): Promise<boolean> {
  try {
    const lastReply = lastAutoReplyMap.get(conversationId);
    if (lastReply && Date.now() - lastReply < AUTO_REPLY_COOLDOWN_MS) {
      console.log("[fb-ig-webhook] Auto-reply cooldown active");
      return true;
    }

    const { data: rules, error } = await adminClient
      .from("messenger_auto_replies")
      .select("*")
      .eq("user_id", account.user_id)
      .eq("platform", platform)
      .eq("is_active", true);

    if (error || !rules || rules.length === 0) return false;

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
      console.log("[fb-ig-webhook] Away rule matched");
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
          console.log("[fb-ig-webhook] Keyword rule matched");
          break;
        }
      }
    }

    if (!matchedReply) return false;

    // Skip auto-reply while a human agent is actively assigned to this
    // conversation. The rule still "claims" the message (return true): a
    // human-owned conversation must not fall through to the AI either.
    const { data: assignment } = await adminClient
      .from("whatsapp_conversation_assignments")
      .select("id")
      .eq("conversation_id", conversationId)
      .is("unassigned_at", null)
      .maybeSingle();
    if (assignment) {
      console.log("[fb-ig-webhook] Conversation has an active human agent, skipping auto-reply");
      return true;
    }

    const { graphBase, pageId, pageToken } = await getSendCredentials(adminClient, account);
    const sendUrl = `${graphBase}/${pageId}/messages?access_token=${encodeURIComponent(pageToken)}`;

    const sendRes = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: matchedReply },
      }),
    });

    const sendData = await sendRes.json();
    console.log("[fb-ig-webhook] Auto-reply request completed");

    if (sendRes.ok) {
      lastAutoReplyMap.set(conversationId, Date.now());

      if (matchedRuleId) {
        await adminClient.from("messenger_auto_reply_usage").insert({
          user_id: account.user_id,
          auto_reply_rule_id: matchedRuleId,
          conversation_id: conversationId,
        }).then(() => {
          console.log(`[fb-ig-webhook] Auto-reply usage logged for rule ${matchedRuleId}`);
        }).catch((e: unknown) => {
          console.warn("[fb-ig-webhook] Failed to log auto-reply usage:", e);
        });
      }
    } else {
      console.error("[fb-ig-webhook] Auto-reply send failed:", sendData);
    }
    // A rule matched; precedence is decided by the match, not the send result.
    return true;
  } catch (err) {
    console.error("[fb-ig-webhook] Auto-reply failed:", err);
    // Rule evaluation failed before a match was established; the AI agent may
    // still answer as a fallback.
    return false;
  }
}

// Fire-and-forget hand-off to the internal AI agent reply engine. The
// ai-agent-reply function enforces its own gates (enabled flag, engagement
// mode, human assignment, cooldown, daily cap).
async function triggerAiAgentReply(
  account: SocialAccountForMessaging,
  platform: "facebook" | "instagram",
  conversationId: string,
  senderId: string,
  inboundText: string,
) {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetch(`${supabaseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      user_id: account.user_id,
      platform,
      social_account_id: account.id,
      conversation_id: conversationId,
      recipient_phone: senderId,
      inbound_text: inboundText,
    }),
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    console.error(`[fb-ig-webhook] ai-agent-reply returned ${response.status}: ${text.slice(0, 200)}`);
  }
}
