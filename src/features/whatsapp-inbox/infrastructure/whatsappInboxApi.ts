import type {
  GetWhatsAppMediaRequest,
  GetWhatsAppMediaResponse,
  SendWhatsAppInteractiveRequest,
  SendWhatsAppMediaRequest,
  WhatsAppInboxApi,
} from "../application/ports";
import { callMessagingApi } from "./messagingApiClient";

export function createWhatsAppInboxApi(): WhatsAppInboxApi {
  return {
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
