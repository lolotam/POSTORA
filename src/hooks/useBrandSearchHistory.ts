import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export type BrandSearchScope = "analyze" | "discovery" | "keyword_search";

export interface BrandSearchHistoryRow {
  id: string;
  query: string;
  use_count: number;
  last_used_at: string;
}

/**
 * Per-user, per-(platform, scope) search history for /analytics/* search bars.
 * Backed by public.brand_search_history (see migration).
 */
export function useBrandSearchHistory(platform: string, scope: BrandSearchScope) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const qc = useQueryClient();
  const queryKey = ["brand_search_history", platform, scope, userId];

  const { data: items = [] } = useQuery<BrandSearchHistoryRow[]>({
    queryKey,
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await (supabase as any)
        .from("brand_search_history")
        .select("id, query, use_count, last_used_at")
        .eq("user_id", userId)
        .eq("platform", platform)
        .eq("scope", scope)
        .order("last_used_at", { ascending: false })
        .limit(15);
      if (error) {
        console.warn("[brand_search_history] load failed", error.message);
        return [];
      }
      return (data || []) as BrandSearchHistoryRow[];
    },
    enabled: !!userId,
    staleTime: 30_000,
  });

  const saveMutation = useMutation({
    mutationFn: async (rawQuery: string) => {
      if (!userId) return;
      const query = rawQuery.trim();
      if (!query) return;
      const db = supabase as any;
      const { data: existing } = await db
        .from("brand_search_history")
        .select("id, use_count")
        .eq("user_id", userId)
        .eq("platform", platform)
        .eq("scope", scope)
        .ilike("query", query)
        .maybeSingle();
      const nowIso = new Date().toISOString();
      if (existing) {
        await db
          .from("brand_search_history")
          .update({ use_count: (existing.use_count ?? 0) + 1, last_used_at: nowIso, query })
          .eq("id", existing.id);
      } else {
        await db.from("brand_search_history").insert({
          user_id: userId,
          platform,
          scope,
          query,
        });
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  const deleteMutation = useMutation({
    mutationFn: async (id: string) => {
      await (supabase as any).from("brand_search_history").delete().eq("id", id);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey }),
  });

  return {
    items,
    save: (q: string) => saveMutation.mutateAsync(q),
    remove: (id: string) => deleteMutation.mutateAsync(id),
  };
}
