import { createContext, useContext } from "react";
import type { MessageCursor } from "../domain/messageCursor";

export type { MessageCursor };

export type WhatsAppAttachmentKind = "image" | "video" | "audio" | "document";

export const MEDIA_UNAVAILABLE = "MEDIA_UNAVAILABLE" as const;
export type MediaUnavailableError = typeof MEDIA_UNAVAILABLE;

export interface WhatsAppAttachment {
  kind: WhatsAppAttachmentKind;
  message_row_id: string;
  mime_type: string | null;
  name: string | null;
  needs_fetch: boolean;
  file_url: string | null;
  duration_seconds?: number | null;
}

export interface WhatsAppResolvedMedia {
  message_row_id: string;
  kind: WhatsAppAttachmentKind;
  url: string | null;
  expires_in?: number;
  mime_type?: string | null;
  file_name?: string;
  size_bytes?: number;
  error?: MediaUnavailableError;
}

export interface GetWhatsAppMediaRequest {
  social_account_id: string;
  message_row_ids: string[];
}

export interface GetWhatsAppMediaResponse {
  media: WhatsAppResolvedMedia[];
}

export interface SendWhatsAppMediaRequest {
  social_account_id: string;
  recipient_phone: string;
  media_path: string;
  media_type: WhatsAppAttachmentKind;
  caption?: string;
}

export interface SendWhatsAppInteractiveRequest {
  social_account_id: string;
  recipient_phone: string;
  interactive: unknown;
}

export interface WhatsAppMessage {
  id: string;
  message: string;
  from: { name: string; id: string };
  to: Array<{ name: string; id: string }>;
  created_time: string;
  attachments: WhatsAppAttachment[];
  media_understanding?: string | null;
  provider_message_id?: string | null;
  direction?: string | null;
  status?: string | null;
  revoked_at?: string | null;
  revoked_by?: string | null;
  conversation_id?: string;
}

export interface GetMessagesPageRequest {
  social_account_id: string;
  conversation_id: string;
  limit?: number;
  before?: MessageCursor;
}

export interface GetMessagesPageResponse {
  messages: WhatsAppMessage[];
  page_info?: {
    next_before: MessageCursor | null;
    has_more: boolean;
  };
}

export interface WhatsAppInboxApi {
  getMessagesPage(input: GetMessagesPageRequest): Promise<GetMessagesPageResponse>;
  getMedia(input: GetWhatsAppMediaRequest): Promise<GetWhatsAppMediaResponse>;
  sendMedia(input: SendWhatsAppMediaRequest): Promise<unknown>;
  sendInteractive(input: SendWhatsAppInteractiveRequest): Promise<unknown>;
}

export const WhatsAppInboxApiContext = createContext<WhatsAppInboxApi | null>(null);

export function useWhatsAppInboxApi(): WhatsAppInboxApi {
  const api = useContext(WhatsAppInboxApiContext);
  if (!api) {
    throw new Error("useWhatsAppInboxApi must be used within WhatsAppInboxApiProvider");
  }
  return api;
}
