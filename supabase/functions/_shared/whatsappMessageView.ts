// Maps a whatsapp_messages row to the messaging-api response shape.
//
// Additive on purpose: the currently-deployed client ignores unknown fields and
// still reads attachments[].file_url. Do not map revoked_at / revoked_by here —
// those columns do not exist until Phase 4, and selecting them would fail at runtime.

export type WhatsAppAttachmentKind = "image" | "video" | "audio" | "document";

export interface WhatsAppMessageRow {
  id: string;
  message_id?: string | null;
  message_text?: string | null;
  from_name?: string | null;
  from_phone?: string | null;
  to_phone?: string | null;
  timestamp?: string | null;
  media_url?: string | null;
  media_type?: string | null;
  media_metadata?: unknown;
  media_understanding?: string | null;
  direction?: string | null;
  status?: string | null;
}

export interface WhatsAppMessageView {
  id: string;
  message: string;
  from: { name: string; id: string };
  to: Array<{ name: string; id: string }>;
  created_time: string | null;
  provider_message_id: string | null;
  direction: string | null;
  status: string | null;
  media_understanding: string | null;
  attachments: WhatsAppAttachmentView[];
}

export interface WhatsAppAttachmentView {
  kind: WhatsAppAttachmentKind;
  message_row_id: string;
  mime_type: string | null;
  name: string | null;
  duration_seconds: number | null;
  needs_fetch: boolean;
  file_url: string | null;
}

/**
 * sticker is stored as its own media_type (26 live rows) but renders as an image.
 */
export function attachmentKindFromMediaType(
  mediaType: string | null | undefined,
): WhatsAppAttachmentKind {
  if (mediaType === "image" || mediaType === "sticker") return "image";
  if (mediaType === "video") return "video";
  if (mediaType === "audio") return "audio";
  return "document";
}

function metadataRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function metadataString(meta: Record<string, unknown> | null, key: string): string | null {
  const value = meta?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function metadataNumber(meta: Record<string, unknown> | null, key: string): number | null {
  const value = meta?.[key];
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : null;
}

export function toWhatsAppMessageView(row: WhatsAppMessageRow): WhatsAppMessageView {
  return {
    id: row.id,
    message: row.message_text || "",
    from: { name: row.from_name || row.from_phone || "Unknown", id: row.from_phone || "" },
    to: [{ name: "", id: row.to_phone || "" }],
    created_time: row.timestamp ?? null,
    provider_message_id: row.message_id ?? null,
    direction: row.direction ?? null,
    status: row.status ?? null,
    media_understanding: row.media_understanding ?? null,
    attachments: attachmentsFor(row),
  };
}

function attachmentsFor(row: WhatsAppMessageRow): WhatsAppAttachmentView[] {
  if (!row.media_type) return [];
  const meta = metadataRecord(row.media_metadata);
  return [{
    kind: attachmentKindFromMediaType(row.media_type),
    message_row_id: row.id,
    mime_type: metadataString(meta, "mime_type"),
    name: metadataString(meta, "filename") ?? metadataString(meta, "file_name"),
    // Inbound Evolution rows carry only a mime type, so this is usually null and the player
    // falls back to the loaded element. Outbound voice notes record it (Phase 5), and the
    // player prefers it because an element duration is not known until metadata loads.
    duration_seconds: metadataNumber(meta, "duration_seconds") ?? metadataNumber(meta, "seconds"),
    // Storage paths and lookaside Graph URLs are not browser-safe; the client
    // must go through whatsapp_get_media for a signed URL.
    needs_fetch: true,
    file_url: row.media_url ?? null,
  }];
}
