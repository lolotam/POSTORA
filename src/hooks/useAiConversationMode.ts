import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";
import { type AiAgentMode, type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

export interface AiConversationMode {
  id: string;
  user_id: string;
  platform: AiAgentPlatform;
  conversation_id: string;
  mode: AiAgentMode;
  /** Set only by escalation; a manual override never carries it. */
  expires_at?: string | null;
  /** The AI's two-line handoff note for the human, written when it escalates. */
  handoff_summary?: string | null;
  handoff_summary_at?: string | null;
  created_at: string;
  updated_at: string;
}

export function useAiConversationMode(platform: AiAgentPlatform, conversationId: string | null) {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["ai-conversation-mode", platform, conversationId];
  const query = useQuery({
    queryKey,
    queryFn: async () => {
      const data = await callMessagingApi("ai_get_conversation_mode", { platform, conversation_id: conversationId });
      return (data.mode || null) as AiConversationMode | null;
    },
    enabled: !!session && !!conversationId,
    // A badge created or expired while the pane is open updates without a
    // reload (debate finding 12).
    refetchInterval: 60_000,
  });

  const setConversationMode = useMutation({
    mutationFn: async (mode: AiAgentMode | "default" | null) => {
      if (!conversationId) throw new Error("Conversation ID is required");
      const data = await callMessagingApi("ai_set_conversation_mode", { platform, conversation_id: conversationId, mode });
      return (data.mode || null) as AiConversationMode | null;
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });

  return { mode: query.data, isLoading: query.isLoading, setConversationMode };
}