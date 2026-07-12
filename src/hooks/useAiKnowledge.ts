/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { callAiKnowledgeApi } from "@/lib/aiKnowledgeApi";

export interface AiKnowledgeSource {
  id: string;
  file_name: string | null;
  file_path: string | null;
  source_type: string;
  status: "pending" | "processing" | "ready" | "failed";
  error: string | null;
  chunk_count: number;
  created_at: string;
}
export interface AiKnowledgeGraphExport {
  html_url: string | null;
  vault_url: string | null;
  generated_at: string;
}
export function useAiKnowledge() {
  const { user } = useAuth();
  const client = useQueryClient();
  const sources = useQuery({
    queryKey: ["ai-knowledge-sources", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_knowledge_sources")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return data as AiKnowledgeSource[];
    },
    refetchInterval: (query) =>
      query.state.data?.some((source: AiKnowledgeSource) =>
        ["pending", "processing"].includes(source.status),
      )
        ? 5000
        : false,
  });
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["ai-knowledge-sources", user?.id] }),
      client.invalidateQueries({ queryKey: ["ai-knowledge-graph-export", user?.id] }),
    ]);
  const graphExport = useQuery({
    queryKey: ["ai-knowledge-graph-export", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_knowledge_graph_exports")
        .select("html_url, vault_url, generated_at")
        .eq("user_id", user?.id)
        .maybeSingle();
      if (error) throw error;
      return data as AiKnowledgeGraphExport | null;
    },
  });
  const invoke = useMutation({
    mutationFn: ({
      action,
      ...body
    }: {
      action: string;
      [key: string]: unknown;
    }) => callAiKnowledgeApi(action, body),
    onSuccess: refresh,
  });
  return {
    user,
    sources: sources.data || [],
    isLoading: sources.isLoading,
    error: sources.error,
    graphExport: graphExport.data || null,
    refetch: sources.refetch,
    invoke,
  };
}
