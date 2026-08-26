import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callMessagingApi } from "@/lib/messagingApi";

/**
 * Canonical frontend contract for AI agent connector tools.
 * Mirrors the ai_agent_tools table and the validation rules of the
 * `ai_upsert_tool` / `ai_list_tools` actions in the messaging-api edge
 * function. Secrets are never returned — only `has_secret`.
 */
export const CONNECTOR_TYPES = [
  "supabase",
  "mysql_postgres",
  "woocommerce",
  "shopify",
  "salla",
  "zid",
  "myfatoorah",
  "stripe",
  "higgsfield",
  "formula",
  "custom_rest",
  "mcp_custom",
] as const;

export type ConnectorType = (typeof CONNECTOR_TYPES)[number];

export interface ToolPermissions {
  search_products: boolean;
  check_stock: boolean;
  lookup_orders: boolean;
}

export interface AiAgentTool {
  id: string;
  name: string;
  description: string;
  tool_type: "builtin" | "n8n_webhook";
  url: string | null;
  has_secret: boolean;
  is_enabled: boolean;
  admin_only: boolean;
  connector_type: ConnectorType;
  permissions: ToolPermissions;
  read_only_mode: boolean;
  enable_cache: boolean;
  created_at: string;
}

export interface AiAgentToolInput {
  name: string;
  description: string;
  url: string;
  /** Provide a non-empty string to set/replace; omit to keep the stored secret. */
  secret?: string | null;
  /** Explicitly remove the stored secret. */
  clear_secret?: boolean;
  is_enabled?: boolean;
  admin_only?: boolean;
  connector_type?: ConnectorType;
  permissions?: ToolPermissions;
  read_only_mode?: boolean;
  enable_cache?: boolean;
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
