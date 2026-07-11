import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";

export interface AiAgentTool {
  id: string;
  name: string;
  description: string;
  tool_type: "builtin" | "n8n_webhook";
  url: string | null;
  secret: string | null;
  is_enabled: boolean;
  admin_only: boolean;
  created_at: string;
}

export interface AiAgentToolInput {
  name: string;
  description: string;
  url: string;
  secret?: string | null;
  is_enabled?: boolean;
  admin_only?: boolean;
}

export function useAiAgentTools() {
  const { session } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["ai-agent-tools"];

  const query = useQuery({
    queryKey,
    enabled: !!session,
    queryFn: async () => {
      const data = await callMessagingApi("ai_list_tools", {});
      return (data.tools || []) as AiAgentTool[];
    },
  });

  const invalidate = () => queryClient.invalidateQueries({ queryKey });

  const upsertTool = useMutation({
    mutationFn: async (tool: AiAgentToolInput) => {
      const data = await callMessagingApi("ai_upsert_tool", { tool });
      return data.tool as AiAgentTool;
    },
    onSuccess: invalidate,
  });

  const deleteTool = useMutation({
    mutationFn: (toolId: string) => callMessagingApi("ai_delete_tool", { tool_id: toolId }),
    onSuccess: invalidate,
  });

  return { tools: query.data || [], isLoading: query.isLoading, upsertTool, deleteTool };
}
