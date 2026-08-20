import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runInBackground } from "../_shared/background.ts";
import { buildMessagePayload, dispatchMessageEvent } from "../_shared/n8nMessagingDispatch.ts";
import { verifyEvolutionWebhookToken } from "../_shared/evolutionWebhookAuth.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

interface EvolutionAccount {
  id: string;
  user_id: string;
  workspace_id: string;
  platform_user_id: string;
  account_metadata: Record<string, unknown> | null;
}

interface EvolutionInstance {
  social_account_id: string;
  instance_name: string;
  jwt_key: string;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function getMessageText(message: any): { text: string; type: string; mediaType: string | null; mediaMetadata: Record<string, unknown> | null } {
  const messageBody = message?.message || {};
  if (messageBody.conversation) return { text: messageBody.conversation, type: "text", mediaType: null, mediaMetadata: null };
  if (messageBody.extendedTextMessage?.text) return { text: messageBody.extendedTextMessage.text, type: "text", mediaType: null, mediaMetadata: null };
  if (messageBody.imageMessage) return {
    text: messageBody.imageMessage.caption || "[Image]",
    type: "image",
    mediaType: "image",
    mediaMetadata: { mime_type: messageBody.imageMessage.mimetype || null },
  };
  if (messageBody.videoMessage) return {
    text: messageBody.videoMessage.caption || "[Video]",
    type: "video",
    mediaType: "video",
    mediaMetadata: { mime_type: messageBody.videoMessage.mimetype || null },
  };
  if (messageBody.documentMessage) return {
    text: `[Document] ${messageBody.documentMessage.fileName || ""}`,
    type: "document",
    mediaType: "document",
    mediaMetadata: {
      mime_type: messageBody.documentMessage.mimetype || null,
      filename: messageBody.documentMessage.fileName || null,
    },
  };
  if (messageBody.audioMessage) return {
    text: "[Audio message]",
    type: "audio",
    mediaType: "audio",
    mediaMetadata: { mime_type: messageBody.audioMessage.mimetype || null },
  };
  if (messageBody.stickerMessage) return {
    text: "[Sticker]",
    type: "sticker",
    mediaType: "sticker",
    mediaMetadata: { mime_type: messageBody.stickerMessage.mimetype || null },
  };
  if (messageBody.buttonsResponseMessage) return {
    text: messageBody.buttonsResponseMessage.selectedDisplayText || "[Interactive]",
    type: "interactive",
    mediaType: null,
    mediaMetadata: null,
  };
  if (messageBody.listResponseMessage) return {
    text: messageBody.listResponseMessage.title || "[Interactive]",
    type: "interactive",
    mediaType: null,
    mediaMetadata: null,
  };
  return { text: "[Message]", type: message?.messageType || "unknown", mediaType: null, mediaMetadata: null };
}

function messageTimestamp(message: any): string {
  const seconds = Number(message?.messageTimestamp);
  return Number.isFinite(seconds) && seconds > 0
    ? new Date(seconds * 1000).toISOString()
    : new Date().toISOString();
}

function messageItems(body: any): any[] {
  return Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
}

function isInboundMessage(message: any): boolean {
  const key = message?.key || {};
  const remoteJid = String(key.remoteJid || "");
  return key.fromMe !== true &&
    !message?.status &&
    message?.messageType !== "protocolMessage" &&
    !remoteJid.endsWith("status@broadcast");
}

async function findInstance(admin: any, instanceName: string): Promise<EvolutionInstance | null> {
  const { data, error } = await admin
    .from("whatsapp_evolution_instances")
    .select("social_account_id, instance_name, jwt_key")
    .eq("instance_name", instanceName)
    .maybeSingle();
  if (error) throw error;
  return data as EvolutionInstance | null;
}

async function findAccount(admin: any, socialAccountId: string): Promise<EvolutionAccount | null> {
  const { data, error } = await admin
    .from("social_accounts")
    .select("id, user_id, workspace_id, platform_user_id, account_metadata")
    .eq("id", socialAccountId)
    .eq("platform", "whatsapp")
    .eq("connection_mode", "evolution_qr")
    .maybeSingle();
  if (error) throw error;
  return data as EvolutionAccount | null;
}

async function touchConversation(admin: any, account: EvolutionAccount, conversationId: string, participantName: string, preview: string, timestamp: string): Promise<void> {
  const { data: cached } = await admin
    .from("messaging_cache")
    .select("unread_count")
    .eq("user_id", account.user_id)
    .eq("workspace_id", account.workspace_id)
    .eq("conversation_id", conversationId)
    .maybeSingle();
  await admin.from("messaging_cache").upsert({
    user_id: account.user_id,
    workspace_id: account.workspace_id,
    social_account_id: account.id,
    conversation_id: conversationId,
    platform: "whatsapp",
    participant_name: participantName,
    participant_avatar: null,
    last_message_preview: preview.slice(0, 200),
    last_message_at: timestamp,
    unread_count: (cached?.unread_count || 0) + 1,
    updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,conversation_id" });
}

async function persistInboundMessage(admin: any, account: EvolutionAccount, message: any): Promise<boolean> {
  if (!isInboundMessage(message)) return false;
  const messageId = message?.key?.id;
  const remoteJid = message?.key?.remoteJid;
  if (!messageId || !remoteJid) return false;

  const normalized = getMessageText(message);
  const timestamp = messageTimestamp(message);
  const conversationId = `wa_${account.platform_user_id}_${remoteJid.replace(/\D/g, "") || remoteJid}`;
  const senderName = message?.pushName || remoteJid;
  const { data: insertedRows } = await admin.from("whatsapp_messages").upsert({
    user_id: account.user_id,
    social_account_id: account.id,
    conversation_id: conversationId,
    message_id: messageId,
    from_phone: remoteJid,
    from_name: senderName,
    to_phone: account.platform_user_id,
    message_text: normalized.text,
    message_type: normalized.type,
    media_url: null,
    media_type: normalized.mediaType,
    media_metadata: normalized.mediaMetadata,
    direction: "inbound",
    status: "received",
    timestamp,
  }, { onConflict: "user_id,message_id", ignoreDuplicates: true }).select("id");

  if (!insertedRows || insertedRows.length === 0) return false;
  await touchConversation(admin, account, conversationId, senderName, normalized.text, timestamp);
  await runInBackground("whatsapp evolution message dispatch", () => dispatchMessageEvent(
    admin,
    account.user_id,
    buildMessagePayload({
      platform: "whatsapp",
      socialAccountId: account.id,
      conversationId,
      sender: { id: remoteJid, name: senderName, phone: remoteJid },
      message: {
        id: messageId,
        text: normalized.text,
        type: normalized.type,
        attachments: [],
      },
      timestamp,
    }),
  ));
  return true;
}

async function handleConnectionUpdate(admin: any, account: EvolutionAccount, data: any): Promise<void> {
  const state = String(data?.state || data?.connection || data?.status || "").toLowerCase();
  if (!state) return;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_connection_state: state })
    .eq("social_account_id", account.id);

  if (state === "connecting") return;
  if (state === "close") {
    await admin.from("social_accounts").update({ is_active: false }).eq("id", account.id);
    return;
  }
  if (state !== "open") return;

  const realJid = data?.wuid || data?.wid || data?.user?.id || data?.jid;
  const updates: Record<string, unknown> = { is_active: true };
  if (typeof realJid === "string" && realJid && account.platform_user_id.startsWith("pending_")) {
    updates.platform_user_id = realJid;
  }
  await admin.from("social_accounts").update(updates).eq("id", account.id);
}

async function handleQrUpdate(admin: any, socialAccountId: string, data: any): Promise<void> {
  const qr = data?.qrcode?.base64 || data?.qrcode?.code || data?.base64 || data?.code || null;
  await admin.from("whatsapp_evolution_instances")
    .update({ last_qr: qr, last_connection_state: "connecting" })
    .eq("social_account_id", socialAccountId);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405);

  const rawBody = await req.text();
  let body: any;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const instanceName = body?.instance || body?.instanceName;
  const authorization = req.headers.get("Authorization") || "";
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!instanceName || !token) return jsonResponse({ error: "Unauthorized" }, 401);

  const supabaseUrl = Deno.env.get("SUPABASE_URL");
  const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) return jsonResponse({ error: "Webhook unavailable" }, 503);
  const admin = createClient(supabaseUrl, serviceRoleKey);

  try {
    const instance = await findInstance(admin, instanceName);
    // Evolution's signed token authenticates the instance, not the body. A captured
    // token can therefore be replayed during its short lifetime; message-id
    // idempotency below makes a replayed inbound message a no-op.
    if (!instance || !(await verifyEvolutionWebhookToken(token, instance.jwt_key))) {
      return jsonResponse({ error: "Unauthorized" }, 401);
    }
    const account = await findAccount(admin, instance.social_account_id);
    if (!account) return jsonResponse({ error: "Unauthorized" }, 401);

    if (body.event === "MESSAGES_UPSERT") {
      for (const message of messageItems(body)) await persistInboundMessage(admin, account, message);
    } else if (body.event === "CONNECTION_UPDATE") {
      await handleConnectionUpdate(admin, account, body.data);
    } else if (body.event === "QRCODE_UPDATED") {
      await handleQrUpdate(admin, account.id, body.data);
    }
    return jsonResponse({ received: true });
  } catch (error) {
    console.error("[whatsapp-evolution-webhook] Processing failed:", error instanceof Error ? error.message : "unknown error");
    return jsonResponse({ error: "Webhook processing failed" }, 500);
  }
});
