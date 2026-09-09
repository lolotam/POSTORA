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
  visibility: "shared" | "restricted";
  /** Source-type specific state. Website sources carry their crawl progress here.
   *  The query selects *, so this arrives without a read-site change. */
  metadata?: Record<string, unknown> | null;
  created_at: string;
  /**
   * Newest chunk's created_at — the last time this source was embedded.
   * Not updated_at: sharing toggles write the source row and a trigger
   * advances that column without touching chunks.
   */
  indexed_at: string | null;
}
export interface AiKnowledgeGraphExport {
  html_url: string | null;
  vault_url: string | null;
  generated_at: string;
}

type SourceRow = Omit<AiKnowledgeSource, "indexed_at"> & {
  ai_knowledge_chunks?: { created_at: string }[] | null;
};

function flattenIndexedAt(row: SourceRow): AiKnowledgeSource {
  const { ai_knowledge_chunks, ...source } = row;
  return {
    ...source,
    indexed_at: ai_knowledge_chunks?.[0]?.created_at ?? null,
  };
}

/**
 * Mint a short-lived download URL for a file-backed source.
 * Not signed in the browser: four stored file_path formats exist, and only
 * the edge action's locator covers all of them.
 */
export async function requestSourceDownloadUrl(sourceId: string): Promise<string> {
  const data = await callAiKnowledgeApi("download_source", { source_id: sourceId });
  const url = data?.url;
  if (typeof url !== "string" || url.length === 0) {
    throw new Error("Download link is unavailable");
  }
  return url;
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
        .select("*, ai_knowledge_chunks(created_at)")
        .order("created_at", { ascending: false })
        .order("created_at", { referencedTable: "ai_knowledge_chunks", ascending: false })
        .limit(1, { referencedTable: "ai_knowledge_chunks" });
      if (error) throw error;
      return ((data ?? []) as SourceRow[]).map(flattenIndexedAt);
    },
    refetchInterval: (query) =>
      query.state.data?.some((source: AiKnowledgeSource) =>
        ["pending", "processing"].includes(source.status),
      )
        ? 5000
        : false,
  });
  // Which accounts each source is explicitly linked to. Read under the user's own
  // JWT against a table whose RLS is `auth.uid() = user_id`, so it can only ever
  // return this user's links -- which is what lets visibleToAccount skip the
  // ownership checks the retrieval RPCs need under the service role.
  const links = useQuery({
    queryKey: ["ai-knowledge-source-accounts", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_knowledge_source_accounts")
        .select("source_id, social_account_id");
      if (error) throw error;
      return data as { source_id: string; social_account_id: string }[];
    },
  });
  const refresh = () =>
    Promise.all([
      client.invalidateQueries({ queryKey: ["ai-knowledge-sources", user?.id] }),
      client.invalidateQueries({ queryKey: ["ai-knowledge-source-accounts", user?.id] }),
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
  // html_url/vault_url are durable references (supabase://...) or external
  // delivery URLs — never browser-ready storage links. Resolve through the
  // edge function to mint a short-TTL signed URL when the user opens one.
  const resolveExportUrls = useMutation({
    mutationFn: async () => {
      const data = await callAiKnowledgeApi("resolve_export_urls", {});
      return {
        html_url: (data.html_url ?? null) as string | null,
        vault_url: (data.vault_url ?? null) as string | null,
      };
    },
  });
  return {
    user,
    sources: sources.data || [],
    links: links.data || [],
    // The links query gates which sources are visible, so an unsettled or failed
    // link read must never look like "this account has no links". Substituting []
    // would hide every restricted source and tell the user none are available --
    // confidently, and wrongly. Callers wait for linksReady before filtering.
    linksReady: links.isSuccess,
    linksError: links.error,
    isLoading: sources.isLoading || links.isLoading,
    error: sources.error,
    graphExport: graphExport.data || null,
    refetch: sources.refetch,
    invoke,
    resolveExportUrls,
  };
}
