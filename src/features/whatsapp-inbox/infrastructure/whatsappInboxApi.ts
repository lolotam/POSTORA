import type {
  GetMessagesPageRequest,
  GetMessagesPageResponse,
  GetWhatsAppMediaRequest,
  GetWhatsAppMediaResponse,
  SendWhatsAppInteractiveRequest,
  SendWhatsAppMediaRequest,
  WhatsAppInboxApi,
  WhatsAppMessage,
} from "../application/ports";
import { callMessagingApi } from "./messagingApiClient";

function toInboxMessages(payload: GetMessagesPageResponse, conversationId: string): WhatsAppMessage[] {
  return (payload.messages ?? []).map((row) => ({
    ...row,
    created_time: row.created_time ?? "",
    attachments: row.attachments ?? [],
    conversation_id: row.conversation_id ?? conversationId,
  }));
}

export function createWhatsAppInboxApi(): WhatsAppInboxApi {
  return {
    async getMessagesPage(input: GetMessagesPageRequest): Promise<GetMessagesPageResponse> {
      const body: Record<string, unknown> = {
        social_account_id: input.social_account_id,
        conversation_id: input.conversation_id,
      };
      if (input.limit != null) body.limit = input.limit;
      if (input.before != null) body.before = input.before;
      const payload = await callMessagingApi<GetMessagesPageResponse>("whatsapp_get_messages", body);
      return {
        messages: toInboxMessages(payload, input.conversation_id),
        page_info: payload.page_info,
      };
    },
    getMedia(input: GetWhatsAppMediaRequest): Promise<GetWhatsAppMediaResponse> {
      return callMessagingApi<GetWhatsAppMediaResponse>("whatsapp_get_media", { ...input });
    },
    sendMedia(input: SendWhatsAppMediaRequest): Promise<unknown> {
      return callMessagingApi("whatsapp_send_media", { ...input });
    },
    sendInteractive(input: SendWhatsAppInteractiveRequest): Promise<unknown> {
      return callMessagingApi("whatsapp_send_interactive", { ...input });
    },
  };
}
