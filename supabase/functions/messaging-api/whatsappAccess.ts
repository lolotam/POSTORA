import {
  requireWhatsAppWorkspaceAccess,
  type WhatsAppAccountAccess,
  type WhatsAppWorkspaceAccessClient,
  type WorkspaceRole,
} from "../_shared/whatsappWorkspaceAccess.ts";

export type WhatsAppAction =
  | "whatsapp_register_phone"
  | "whatsapp_send_message"
  | "whatsapp_send_template"
  | "whatsapp_list_templates"
  | "whatsapp_create_template"
  | "whatsapp_get_analytics"
  | "whatsapp_list_conversations"
  | "whatsapp_get_messages"
  | "whatsapp_get_media"
  | "whatsapp_mark_read"
  | "whatsapp_send_media"
  | "whatsapp_send_interactive"
  | "whatsapp_delete_template"
  | "whatsapp_get_catalog"
  | "whatsapp_get_products"
  | "whatsapp_send_product"
  | "whatsapp_send_product_list"
  | "whatsapp_get_conversation_state"
  | "whatsapp_set_message_flag"
  | "whatsapp_revoke_message";

export const WHATSAPP_ACTION_MINIMUM_ROLE: Record<
  WhatsAppAction,
  WorkspaceRole
> = {
  whatsapp_register_phone: "admin",
  whatsapp_send_message: "agent",
  whatsapp_send_template: "agent",
  whatsapp_list_templates: "viewer",
  whatsapp_create_template: "admin",
  whatsapp_get_analytics: "viewer",
  whatsapp_list_conversations: "viewer",
  whatsapp_get_messages: "viewer",
  whatsapp_get_media: "viewer",
  whatsapp_mark_read: "agent",
  whatsapp_send_media: "agent",
  whatsapp_send_interactive: "agent",
  whatsapp_delete_template: "admin",
  whatsapp_get_catalog: "viewer",
  whatsapp_get_products: "viewer",
  whatsapp_send_product: "agent",
  whatsapp_send_product_list: "agent",
  whatsapp_get_conversation_state: "viewer",
  whatsapp_set_message_flag: "viewer",
  whatsapp_revoke_message: "agent",
};

export interface WhatsAppActionAccessRequest {
  client: WhatsAppWorkspaceAccessClient;
  userId: string;
  action: WhatsAppAction;
  socialAccountId: string;
}

export async function withWhatsAppActionAccess<T>(
  request: WhatsAppActionAccessRequest,
  operation: (access: WhatsAppAccountAccess) => Promise<T>,
): Promise<T> {
  const access = await requireWhatsAppWorkspaceAccess(
    request.client,
    request.userId,
    request.socialAccountId,
    WHATSAPP_ACTION_MINIMUM_ROLE[request.action],
  );
  return await operation(access);
}
