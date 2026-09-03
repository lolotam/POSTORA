import { useAutoReplyRules, type AutoReplyRuleInput } from "./useAutoReplyRules";

export type MessengerPlatform = "facebook" | "instagram" | "threads" | "youtube";

export function useMessengerAutoReplies(platform: MessengerPlatform, enabled = true) {
  return useAutoReplyRules(
    "messenger_auto_replies",
    ["messenger-auto-replies", platform],
    { platform },
    enabled,
  );
}

export type { AutoReplyRuleInput as MessengerAutoReplyInput };
