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
//
// Group and privacy JIDs are skipped to match the history sync: their digits are not phone
// numbers, so they would collide inside the wa_<owner>_<number> conversation id and could
// not be replied to.
function isPersistableMessage(message: any): boolean {
  const remoteJid = String(message?.key?.remoteJid || "");
  return Boolean(message?.message) &&
    message?.messageType !== "protocolMessage" &&
    !remoteJid.endsWith("status@broadcast") &&
    !remoteJid.endsWith("@g.us") &&
    !remoteJid.endsWith("@lid");
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

export function buildEvolutionMessageRow(
  account: EvolutionMessageAccount,
  message: any,
): EvolutionMessageRow | null {
  if (!isPersistableMessage(message)) return null;
  const messageId = message?.key?.id;
  const remoteJid = message?.key?.remoteJid;
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
