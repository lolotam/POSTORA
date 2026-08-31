import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { callMessagingApi } from "@/lib/messagingApi";

/**
 * Canonical frontend contract for AI agent connector tools.
 * Mirrors the ai_agent_tools table and the validation rules of the
 * `ai_upsert_tool` / `ai_list_tools` actions in the messaging-api edge
 * function. Secrets are never returned — only `has_secret` plus the NAMES of
 * the credential fields that have values (`configured_secret_fields`), which
 * is what lets the UI render "Consumer secret ✓ set" without ever seeing a
 * decrypted credential.
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

/** Connector sharing scope: one owning account, or every account including
 *  ones connected later (spec §4.1). Legacy rows are 'all_accounts'. */
export type ToolScope = "account" | "all_accounts";

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
  /** The account this connector belongs to; null only for legacy 'all_accounts' rows. */
  social_account_id: string | null;
  scope: ToolScope;
  platform: string | null;
  /** Non-secret connection facts, readable by the UI. */
  settings: Record<string, unknown> | null;
  /** The secret field NAMES that have values — never the values themselves. */
  configured_secret_fields: string[];
  /** Last test_connection probe, written by the ai-agent-adapters service —
   *  never by the browser. Null means the connector has never been tested. */
  last_test_at: string | null;
  last_test_ok: boolean | null;
  last_test_error: string | null;
  created_at: string;
}

export interface AiAgentToolInput {
  name: string;
  description: string;
  url: string;
  /** Owning account. The server refuses a save without it — an account-less
   *  write against an account-scoped table is how unscoped rows get created. */
  social_account_id: string;
  /** Registry-partitioned credential values keyed by registry field name:
   *  secret fields route to the Vault blob, non-secret fields to `settings`.
   *  An omitted or blank value keeps whatever is stored ("keep existing"). */
  credentials?: Record<string, string>;
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

/** Link row of ai_agent_tool_accounts: a connector explicitly shared with an
 *  account that does not own it. */
export interface ToolAccountLink {
  tool_id: string;
  social_account_id: string;
}

export function useAiAgentTools() {
  const { session, user } = useAuth();
  const queryClient = useQueryClient();
  // Keyed by user id so a cache written by one login is never served to
  // another after a same-tab account switch.
  const queryKey = ["ai-agent-tools", user?.id];

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

/**
 * Which accounts each connector is shared with, plus the write that replaces
 * a connector's whole link set. The read runs in the browser under the user's
 * own JWT against a table whose RLS is `auth.uid() = user_id` (the reason the
 * link rows denormalise user_id), so it can only ever return this user's
 * links; the write goes through messaging-api because the replacing RPC is
 * granted to service_role only.
 */
export function useAiToolAccountLinks() {
  const { user } = useAuth();
  const queryClient = useQueryClient();
  const queryKey = ["ai-agent-tool-accounts", user?.id];

  const links = useQuery({
    queryKey,
    enabled: !!user,
    queryFn: async () => {
      // The table is not in the generated database types yet (Migration A is
      // applied by hand by the owner), so this goes through the same
      // untyped-client precedent useAiKnowledge uses for its link table.
      const { data, error } = await (supabase as unknown as {
        from: (table: string) => {
          select: (columns: string) => PromiseLike<{
            data: ToolAccountLink[] | null;
            error: unknown;
          }>;
        };
      })
        .from("ai_agent_tool_accounts")
        .select("tool_id, social_account_id");
      if (error) throw error;
      return (data || []) as ToolAccountLink[];
    },
  });

  const setToolAccounts = useMutation({
    mutationFn: async ({
      toolId,
      socialAccountIds,
    }: {
      toolId: string;
      socialAccountIds: string[];
    }) =>
      callMessagingApi("set_tool_accounts", {
        tool_id: toolId,
        social_account_ids: socialAccountIds,
      }),
    onSuccess: () => {
      // Fresh links are needed before the next toggle computes its full
      // replacement set; fresh tools keep the strip counts honest.
      void queryClient.invalidateQueries({ queryKey });
      void queryClient.invalidateQueries({ queryKey: ["ai-agent-tools", user?.id] });
    },
  });

  return {
    links: links.data || [],
    // An unsettled or failed read must never look like "no links" — callers
    // wait for linksReady before drawing a strip whose ticks state facts.
    linksReady: links.isSuccess,
    linksError: links.error,
    setToolAccounts,
  };
}
