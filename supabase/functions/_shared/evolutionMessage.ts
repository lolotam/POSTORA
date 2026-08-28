// Shared shape rules for a Baileys message arriving from Evolution.
//
// Two paths write whatsapp_messages rows: the live messages.upsert webhook and the
// historical sync sweep. They must agree exactly -- the same message reaching Postora by
// either route has to produce the same row, or one conversation renders two ways
// depending on how it happened to arrive.

export interface EvolutionMessageAccount {
  id: string;
  user_id: string;
  platform_user_id: string;
}

export interface EvolutionMessageContent {
  text: string;
  type: string;
  mediaType: string | null;
  mediaMetadata: Record<string, unknown> | null;
}

export interface EvolutionMessageRow {
  row: Record<string, unknown>;
  conversationId: string;
  sentByOwner: boolean;
  participantName: string;
  preview: string;
  timestamp: string;
}

// Owner-sent messages are inbox content on a QR link -- the operator answering from their
// own phone is the same conversation -- so fromMe is kept rather than discarded.
//
// There is deliberately no `!message.status` guard: Evolution stamps a delivery status
// onto real messages, so that condition dropped genuine traffic instead of the status
// events it was meant to skip. Requiring a message body is the check actually intended.
function isPersistableMessage(message: any): boolean {
  return Boolean(message?.message) && message?.messageType !== "protocolMessage";
}

const DIRECT_JID_SUFFIX = "@s.whatsapp.net";
const LID_JID_SUFFIX = "@lid";

/**
 * The phone-addressed JID a message belongs to, or null when it has none.
 *
 * Only a subscriber number can address a conversation here: it is both the reply recipient
 * and half of the wa_<owner>_<number> id. A group, a newsletter or a status broadcast has
 * none, so those are dropped.
 *
 * WhatsApp's LID migration is why this is not simply `key.remoteJid`. A growing share of
 * one-to-one chats now arrive addressed by an opaque "<id>@lid" identity, with the
 * subscriber number carried alongside as `key.remoteJidAlt` whenever Evolution knows it.
 * Reading only `remoteJid` put the same message in two different conversations depending on
 * which path delivered it: Evolution normalises the live webhook payload to the phone JID
 * but stores the historical record under the LID, so the sweep wrote wa_<owner>_<lid> for a
 * message the webhook had already written as wa_<owner>_<phone>.
 */
export function addressableJid(key: any): string | null {
  const remoteJid = String(key?.remoteJid || "");
  if (remoteJid.endsWith(DIRECT_JID_SUFFIX)) return remoteJid;
  if (!remoteJid.endsWith(LID_JID_SUFFIX)) return null;
  const alternate = String(key?.remoteJidAlt || "");
  return alternate.endsWith(DIRECT_JID_SUFFIX) ? alternate : null;
}

function describeMessageContent(message: any): EvolutionMessageContent {
  const body = message?.message || {};
  if (body.conversation) return { text: body.conversation, type: "text", mediaType: null, mediaMetadata: null };
  if (body.extendedTextMessage?.text) {
    return { text: body.extendedTextMessage.text, type: "text", mediaType: null, mediaMetadata: null };
  }
  if (body.imageMessage) return {
    text: body.imageMessage.caption || "[Image]",
    type: "image",
    mediaType: "image",
    mediaMetadata: { mime_type: body.imageMessage.mimetype || null },
  };
  if (body.videoMessage) return {
    text: body.videoMessage.caption || "[Video]",
    type: "video",
    mediaType: "video",
    mediaMetadata: { mime_type: body.videoMessage.mimetype || null },
  };
  if (body.documentMessage) return {
    text: `[Document] ${body.documentMessage.fileName || ""}`,
    type: "document",
    mediaType: "document",
    mediaMetadata: {
      mime_type: body.documentMessage.mimetype || null,
      filename: body.documentMessage.fileName || null,
    },
  };
  if (body.audioMessage) return {
    text: "[Audio message]",
    type: "audio",
    mediaType: "audio",
    mediaMetadata: { mime_type: body.audioMessage.mimetype || null },
  };
  if (body.stickerMessage) return {
    text: "[Sticker]",
    type: "sticker",
    mediaType: "sticker",
    mediaMetadata: { mime_type: body.stickerMessage.mimetype || null },
  };
  if (body.buttonsResponseMessage) return {
    text: body.buttonsResponseMessage.selectedDisplayText || "[Interactive]",
    type: "interactive",
    mediaType: null,
    mediaMetadata: null,
  };
  if (body.listResponseMessage) return {
    text: body.listResponseMessage.title || "[Interactive]",
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

function conversationIdFor(account: EvolutionMessageAccount, remoteJid: string): string {
  return `wa_${account.platform_user_id}_${remoteNumberFor(remoteJid)}`;
}

export function remoteNumberFor(remoteJid: string): string {
  // Multi-device JIDs carry a ":<device>" component, e.g. "96597950350:12@s.whatsapp.net".
  // Stripping every non-digit would splice that device number onto the subscriber number and
  // yield "9659795035012" -- a different, fabricated phone number that then flows into both
  // the conversation id and the dispatched sender payload. Take the local part first, the way
  // ownerNumberFromJid already does for the account's own JID.
  const local = remoteJid.split("@")[0].split(":")[0];
  return local.replace(/\D/g, "") || remoteJid;
}

/**
 * `addressFallback` is the address the caller already resolved for the whole chat. Evolution
 * repeats the LID-to-number alternate on only a few keys per LID chat, so a sweep that
 * resolved the chat from one message would otherwise drop every sibling message that does
 * not repeat it. The live webhook resolves per message and passes nothing.
 */
export function buildEvolutionMessageRow(
  account: EvolutionMessageAccount,
  message: any,
  addressFallback: string | null = null,
): EvolutionMessageRow | null {
  if (!isPersistableMessage(message)) return null;
  const messageId = message?.key?.id;
  const remoteJid = addressableJid(message?.key) ?? addressFallback;
  if (!messageId || !remoteJid) return null;

  const content = describeMessageContent(message);
  const timestamp = messageTimestamp(message);
  const remoteNumber = remoteNumberFor(remoteJid);
  const sentByOwner = message?.key?.fromMe === true;
  // The inbox decides which side a bubble sits on by comparing from_phone against the
  // account's platform_user_id, not by reading `direction`, so an owner-sent message has
  // to carry the owner as its sender or it renders as if the contact wrote it.
  const senderName = sentByOwner ? "You" : (message?.pushName || remoteNumber);

  const conversationId = conversationIdFor(account, remoteJid);

  return {
    conversationId,
    sentByOwner,
    // Blank for an owner-sent message: its push name is the operator's own, which must not
    // overwrite the name already resolved for the person on the other end.
    participantName: sentByOwner ? "" : senderName,
    preview: content.text,
    timestamp,
    row: {
      user_id: account.user_id,
      social_account_id: account.id,
      conversation_id: conversationId,
      message_id: messageId,
      from_phone: sentByOwner ? account.platform_user_id : remoteNumber,
      from_name: senderName,
      to_phone: sentByOwner ? remoteNumber : account.platform_user_id,
      message_text: content.text,
      message_type: content.type,
      media_url: null,
      media_type: content.mediaType,
      media_metadata: content.mediaMetadata,
      direction: sentByOwner ? "outbound" : "inbound",
      status: sentByOwner ? "sent" : "received",
      timestamp,
    },
  };
}
