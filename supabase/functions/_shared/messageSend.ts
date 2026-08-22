import { getSendCredentials, type SocialAccountForMessaging } from "./messengerCredentials.ts";
import {
  resolveWhatsAppTransport,
  type WhatsAppSendMediaInput,
  type WhatsAppTransport,
  type WhatsAppTransportAccount,
} from "./whatsappTransport.ts";

const GRAPH_API = "https://graph.facebook.com/v22.0";

export type OutboundMessageType = "text" | "media";
export const EVOLUTION_MEDIA_TYPES = ["image", "video", "document", "audio"] as const;
export type EvolutionMediaType = typeof EVOLUTION_MEDIA_TYPES[number];

function isEvolutionMediaType(value: unknown): value is EvolutionMediaType {
  return EVOLUTION_MEDIA_TYPES.includes(value as EvolutionMediaType);
}

export interface MessageSendAccount extends SocialAccountForMessaging {
  workspace_id: string | null;
  connection_mode?: WhatsAppTransportAccount["connection_mode"];
}

export interface SendMessageInput {
  account: MessageSendAccount;
  recipientId: string;
  conversationId?: string;
  message: string;
  messageType: OutboundMessageType;
  mediaUrl?: string;
  mediaType?: string;
}

interface SendMessageResult {
  messageId: string;
  data: unknown;
}

type Fetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
type TransportResolver = (adminClient: any, account: WhatsAppTransportAccount) => Promise<WhatsAppTransport>;

export async function sendMessage(
  adminClient: any,
  input: SendMessageInput,
  fetcher: Fetcher = fetch,
  resolveTransport: TransportResolver = resolveWhatsAppTransport,
): Promise<SendMessageResult> {
  if (input.account.platform === "whatsapp") {
    return input.account.connection_mode === "evolution_qr"
      ? sendEvolutionWhatsAppMessage(adminClient, input, resolveTransport)
      : sendWhatsAppMessage(adminClient, input, fetcher);
  }
  return sendMetaMessage(adminClient, input, fetcher);
}

// A QR-linked number has no Meta token: its messages go out through the Evolution
// instance bound to the account, exactly as the in-app inbox sends them. Falling through to
// the Graph API here used the global WHATSAPP_ACCESS_TOKEN and failed with OAuth code 190.
async function sendEvolutionWhatsAppMessage(
  adminClient: any,
  input: SendMessageInput,
  resolveTransport: TransportResolver,
): Promise<SendMessageResult> {
  if (input.messageType === "media" && !input.mediaUrl) throw new Error("media_url is required for media messages");
  const recipientPhone = input.recipientId.replace(/\D/g, "");
  const media = input.messageType === "media" ? evolutionMediaInput(input, recipientPhone) : null;
  const { id, platform_user_id, access_token, account_metadata } = input.account;
  const transport = await resolveTransport(adminClient, {
    id, platform_user_id, access_token, account_metadata, connection_mode: "evolution_qr",
  });
  const result = media
    ? await transport.sendMedia(media)
    : await transport.sendText({ recipientPhone, text: input.message });
  const messageId = result.messageId || `evo_${crypto.randomUUID()}`;
  // The inbound side (webhook + history sync) keys QR threads by bare digits, so the
  // outbound row must use the same digits or the reply lands in a separate thread.
  await persistWhatsAppMessage(adminClient, { ...input, recipientId: recipientPhone }, messageId, platform_user_id);
  return { messageId, data: result.raw };
}

function evolutionMediaInput(input: SendMessageInput, recipientPhone: string): WhatsAppSendMediaInput {
  const mediaUrl = input.mediaUrl!;
  const mediaType = input.mediaType || "document";
  if (!isEvolutionMediaType(mediaType)) {
    throw new Error(`Unsupported media_type "${mediaType}"; expected one of ${EVOLUTION_MEDIA_TYPES.join(", ")}`);
  }
  return {
    recipientPhone,
    mediaUrl,
    mediaType,
    caption: input.message || undefined,
    fileName: mediaUrl.split("/").pop() || undefined,
  };
}

async function sendWhatsAppMessage(adminClient: any, input: SendMessageInput, fetcher: Fetcher): Promise<SendMessageResult> {
  const phoneNumberId = input.account.platform_user_id;
  const token = input.account.access_token || Deno.env.get("WHATSAPP_ACCESS_TOKEN");
  if (!token) throw new Error("WhatsApp account has no access token");
  const payload = buildWhatsAppPayload(input);
  const data = await sendWhatsAppWithRetry(`${GRAPH_API}/${phoneNumberId}/messages`, token, payload, phoneNumberId, input.account.id, fetcher);
  const messageId = data?.messages?.[0]?.id;
  if (!messageId) throw new Error("WhatsApp send returned no message id");
  await persistWhatsAppMessage(adminClient, input, messageId, phoneNumberId);
  return { messageId, data };
}

function buildWhatsAppPayload(input: SendMessageInput): Record<string, unknown> {
  if (input.messageType === "text") {
    return { messaging_product: "whatsapp", to: input.recipientId, type: "text", text: { body: input.message } };
  }
  const mediaType = input.mediaType || "document";
  const media: Record<string, unknown> = { link: input.mediaUrl, ...(input.message ? { caption: input.message } : {}) };
  if (mediaType === "document") media.filename = input.mediaUrl?.split("/").pop() || "file";
  return { messaging_product: "whatsapp", to: input.recipientId, type: mediaType, [mediaType]: media };
}

async function sendMetaMessage(adminClient: any, input: SendMessageInput, fetcher: Fetcher): Promise<SendMessageResult> {
  if (input.messageType === "media" && !input.mediaUrl) throw new Error("media_url is required for media messages");
  const credentials = await getSendCredentials(adminClient, input.account);
  const isConversationReply = input.messageType === "text" && input.conversationId;
  const url = isConversationReply
    ? `${credentials.graphBase}/${input.conversationId}/messages?access_token=${encodeURIComponent(credentials.pageToken)}`
    : `${credentials.graphBase}/${credentials.pageId}/messages?access_token=${encodeURIComponent(credentials.pageToken)}`;
  const payload = isConversationReply
    ? { message: input.message }
    : input.messageType === "media"
      ? { recipient: { id: input.recipientId }, message: { attachment: { type: input.mediaType || "image", payload: { url: input.mediaUrl, is_reusable: false } } } }
      : { recipient: { id: input.recipientId }, message: { text: input.message } };
  const response = await fetcher(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`Graph API error: ${JSON.stringify(data.error || data)}`);
  const messageId = data.message_id || data.id;
  if (!messageId) throw new Error("Meta send returned no message id");
  await persistMetaMessage(adminClient, input);
  return { messageId, data };
}

async function persistWhatsAppMessage(adminClient: any, input: SendMessageInput, messageId: string, phoneNumberId: string): Promise<void> {
  const conversationId = input.conversationId || `wa_${phoneNumberId}_${input.recipientId.replace(/^\+/, "")}`;
  await adminClient.from("whatsapp_messages").insert({
    user_id: input.account.user_id, social_account_id: input.account.id, conversation_id: conversationId,
    message_id: messageId, from_phone: phoneNumberId, from_name: "You", to_phone: input.recipientId,
    message_text: input.message || `[${input.messageType}]`, message_type: input.messageType,
    media_url: input.mediaUrl || null, media_type: input.mediaType || null,
    direction: "outbound", status: "sent", timestamp: new Date().toISOString(),
  });
  await upsertOutboundConversation(adminClient, input.account, input.recipientId, phoneNumberId, input.message || `[${input.messageType}]`);
}

async function persistMetaMessage(adminClient: any, input: SendMessageInput): Promise<void> {
  await adminClient.from("messaging_cache").upsert({
    user_id: input.account.user_id, workspace_id: input.account.workspace_id, social_account_id: input.account.id,
    conversation_id: input.conversationId || `${input.account.id}_${input.recipientId}`, platform: input.account.platform,
    participant_name: input.recipientId, last_message_preview: (input.message || `[${input.messageType}]`).slice(0, 200),
    last_message_at: new Date().toISOString(), unread_count: 0, updated_at: new Date().toISOString(),
  }, { onConflict: "user_id,conversation_id" });
}

async function upsertOutboundConversation(adminClient: any, account: MessageSendAccount, recipientId: string, phoneNumberId: string, preview: string): Promise<void> {
  const normalized = recipientId.replace(/\D/g, "");
  const conversationId = `wa_${phoneNumberId}_${normalized}`;
  const now = new Date().toISOString();
  await adminClient.from("messaging_cache").upsert({
    user_id: account.user_id, workspace_id: account.workspace_id, social_account_id: account.id,
    platform: "whatsapp", conversation_id: conversationId, participant_name: `+${normalized}`,
    last_message_preview: preview.slice(0, 200), last_message_at: now, unread_count: 0, updated_at: now,
  }, { onConflict: "user_id,conversation_id" });
}

async function sendWhatsAppWithRetry(
  url: string, token: string, payload: Record<string, unknown>, phoneNumberId: string, socialAccountId: string, fetcher: Fetcher,
): Promise<any> {
  const response = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
  const data = await response.json();
  const needsRegistration = data.error?.code === 133010 || (data.error?.code === 100 && data.error?.error_subcode === 33);
  if (needsRegistration) {
    await registerWhatsAppPhone(phoneNumberId, token, socialAccountId, fetcher);
    const retry = await fetcher(url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` }, body: JSON.stringify(payload) });
    const retryData = await retry.json();
    if (!retry.ok || retryData.error) throw new Error(`Graph API error after registration: ${JSON.stringify(retryData.error || retryData)}`);
    return retryData;
  }
  if (!response.ok || data.error) throw new Error(`Graph API error: ${JSON.stringify(data.error || data)}`);
  return data;
}

async function registerWhatsAppPhone(phoneNumberId: string, token: string, socialAccountId: string, fetcher: Fetcher): Promise<void> {
  const pin = Deno.env.get("WHATSAPP_VERIFY_PIN") || "000000";
  const response = await fetcher(`${GRAPH_API}/${phoneNumberId}/register`, {
    method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ messaging_product: "whatsapp", pin }),
  });
  const data = await response.json();
  if (!response.ok || data.error) throw new Error(`WhatsApp registration failed for ${socialAccountId}: ${JSON.stringify(data.error || data)}`);
}
