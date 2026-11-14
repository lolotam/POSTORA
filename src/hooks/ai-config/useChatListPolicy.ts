import { useQuery } from '@tanstack/react-query';
import { CHAT_LIST_POLICY_QUERY_KEY, fetchChatListPolicy } from '@/features/ai-providers/infrastructure/chatListGateway';

export function useChatListPolicy(enabled: boolean) {
  return useQuery({ queryKey: CHAT_LIST_POLICY_QUERY_KEY, queryFn: fetchChatListPolicy, enabled, retry: false });
}
