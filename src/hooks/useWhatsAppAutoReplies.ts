import { useAutoReplyRules, type AutoReplyRule, type AutoReplyRuleInput } from "./useAutoReplyRules";

export type WhatsAppAutoReply = AutoReplyRule;
export type AutoReplyInput = AutoReplyRuleInput;

export function useWhatsAppAutoReplies(enabled = true) {
  return useAutoReplyRules("whatsapp_auto_replies", ["whatsapp-auto-replies"], {}, enabled);
}
