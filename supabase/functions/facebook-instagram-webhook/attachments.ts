// Reading Meta's messaging attachments: what kind they are, what to call them, and which
// one of them we can actually understand.
//
// A sibling module rather than part of index.ts so it can be tested, the same way
// commentEvents.ts is.

import type { MediaKind } from "../_shared/inboundMediaUnderstanding.ts";

/**
 * Meta's own name for an attachment, mapped to what the understanding pipeline calls it.
 *
 * A messaging webhook carries NO mime type -- only this word and a signed CDN URL -- so
 * this map is the whole of what we know about the bytes before downloading them. `video`
 * and `location` are absent deliberately: nothing here can read them, and a missing entry
 * is what keeps the message on its placeholder instead of paying for a model call.
 *
 * Note `file` covers every non-media attachment, so a Word document arrives hinted as a
 * document too. The pipeline refuses it once the bytes report a mime that is not a PDF.
 */
export const META_ATTACHMENT_KINDS: Record<string, MediaKind> = {
  audio: "audio",
  image: "image",
  file: "document",
};

/**
 * What the agent sees when understanding is off, unavailable, or fails. Naming the type is
 * the point: "[Attachment]" told the agent nothing, so it could not even say "I can see you
 * sent a photo".
 */
export const META_ATTACHMENT_PLACEHOLDERS: Record<string, string> = {
  audio: "[Voice message]",
  image: "[Image]",
  file: "[Document]",
  video: "[Video]",
  location: "[Location]",
};

export interface InboundAttachment {
  metaType: string;
  url: string | null;
  kind: MediaKind | null;
}

/**
 * Meta sends an array on messaging events, but the same field arrives wrapped in `data` on
 * other Graph surfaces, and this webhook already handles both when dispatching to n8n.
 */
export function attachmentList(message: { attachments?: unknown }): unknown[] {
  const raw = message.attachments;
  if (Array.isArray(raw)) return raw;
  const data = (raw as { data?: unknown } | null | undefined)?.data;
  return Array.isArray(data) ? data : [];
}

export function describeAttachment(raw: unknown): InboundAttachment {
  const item = raw as { type?: string; payload?: { url?: string } } | undefined;
  const metaType = String(item?.type ?? "");
  return {
    metaType,
    url: item?.payload?.url ?? null,
    kind: META_ATTACHMENT_KINDS[metaType] ?? null,
  };
}

/**
 * The first attachment we can actually read, which is not always the first one sent.
 *
 * Messenger allows up to 30 attachments on one message, and a customer who sends a video
 * and then the photo they meant to send puts the readable one second. Selecting index 0
 * blind would answer the video -- that is, answer nothing -- while the photo sat unread.
 */
export function firstReadableAttachment(
  message: { attachments?: unknown },
): InboundAttachment | null {
  for (const raw of attachmentList(message)) {
    const described = describeAttachment(raw);
    if (described.kind && described.url) return described;
  }
  return null;
}

/** The placeholder for whatever arrived first, readable or not. */
export function leadPlaceholder(message: { attachments?: unknown }): string | null {
  const list = attachmentList(message);
  if (list.length === 0) return null;
  return META_ATTACHMENT_PLACEHOLDERS[describeAttachment(list[0]).metaType] ?? "[Attachment]";
}

/**
 * Tells the agent what it did not see.
 *
 * Only one attachment per message is read, and logging the rest server-side does not stop
 * the agent answering as though it had seen the whole message. The note is written by this
 * webhook and sits outside the fenced customer content, so it reads as a fact about the
 * message rather than as something the customer said.
 */
export function noteUnreadAttachments(agentText: string, unread: number): string {
  if (unread <= 0) return agentText;
  const what = unread === 1 ? "1 further attachment" : `${unread} further attachments`;
  return `${agentText}\n[The customer also sent ${what} that could not be read.]`;
}
