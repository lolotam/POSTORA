import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

interface HandoffSummaryRow {
  conversation_id: string;
  handoff_summary: string | null;
  expires_at: string | null;
}

/**
 * Handoff summaries for a whole queue in one query — never one per row.
 * The mode row is keyed by user, platform and conversation, so a summary
 * exists there even when no agent was online to take the assignment.
 */
export function useHandoffSummaries(conversationIds: string[]) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  // Deduped and sorted so the query key stays stable however the queue reorders.
  const ids = [...new Set(conversationIds)].sort();

  const query = useQuery({
    queryKey: ["ai-handoff-summaries", userId, ids],
    queryFn: async () => {
      if (!userId || ids.length === 0) return {};
      const { data, error } = await supabase
        .from("ai_conversation_modes")
        .select("conversation_id, handoff_summary, expires_at")
        .eq("user_id", userId)
        .not("handoff_summary", "is", null)
        .gt("expires_at", new Date().toISOString());
      if (error) throw error;
      const listedIds = new Set(ids);
      const summaries: Record<string, string> = {};
      for (const row of (data || []) as HandoffSummaryRow[]) {
        if (listedIds.has(row.conversation_id) && row.handoff_summary) {
          summaries[row.conversation_id] = row.handoff_summary;
        }
      }
      return summaries;
    },
    enabled: !!userId && ids.length > 0,
    refetchInterval: 30_000,
  });

  return { summaries: query.data || {}, isLoading: query.isLoading };
}
