/* eslint-disable @typescript-eslint/no-explicit-any */
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { type AiAgentLog, useAiAgentLogs } from "@/hooks/useAiAgentLogs";

/** Which engine handled an inbound message or comment. */
export type ActivitySource = "postora" | "n8n";
export type ActivitySourceFilter = ActivitySource | "all";

export interface N8nDispatchLog {
  id: string;
  platform: string | null;
  event: string | null;
  conversation_id: string | null;
  inbound_text: string | null;
  destination_count: number | null;
  created_at: string;
}

/**
 * One entry in the activity log, tagged by the engine that produced it.
 *
 * A union rather than a flattened row because the two engines know different things.
 * Postora wrote the reply and can show it; for n8n, Postora only knows the event was
 * handed over and how many subscriptions took it — the workflow's own reply never comes
 * back. Flattening would leave `reply_text` permanently null on n8n rows and invite the
 * view to render it as "replied with nothing".
 */
export type AgentActivity =
  | { source: "postora"; id: string; createdAt: string; log: AiAgentLog }
  | { source: "n8n"; id: string; createdAt: string; dispatch: N8nDispatchLog };

export function useN8nDispatchLogs(platform: AiAgentPlatform) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["n8n-dispatch-logs", platform],
    enabled: !!session,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("automation_dispatch_log")
        .select("id, platform, event, conversation_id, inbound_text, destination_count, created_at")
        .eq("platform", platform)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as N8nDispatchLog[];
    },
  });
}

/**
 * Both engines' activity for one platform, newest first.
 *
 * The two sources are queried separately and merged here rather than joined in the
 * database: they share no key, and the answer the page needs — "who handled this, and
 * when" — is a time ordering, not a relation.
 */
export function useAgentActivity(platform: AiAgentPlatform) {
  const agentLogs = useAiAgentLogs(platform);
  const dispatchLogs = useN8nDispatchLogs(platform);

  const entries = useMemo<AgentActivity[]>(() => {
    const postora: AgentActivity[] = (agentLogs.data || []).map((log) => ({
      source: "postora",
      id: `postora-${log.id}`,
      createdAt: log.created_at,
      log,
    }));
    const n8n: AgentActivity[] = (dispatchLogs.data || []).map((dispatch) => ({
      source: "n8n",
      id: `n8n-${dispatch.id}`,
      createdAt: dispatch.created_at,
      dispatch,
    }));
    return [...postora, ...n8n].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );
  }, [agentLogs.data, dispatchLogs.data]);

  return {
    entries,
    // The dispatch table is new, so a deployment where its migration has not been applied
    // yet must still show the agent's own log rather than an error screen.
    isLoading: agentLogs.isLoading,
    dispatchError: dispatchLogs.error,
  };
}

export function filterActivity(
  entries: AgentActivity[],
  source: ActivitySourceFilter,
): AgentActivity[] {
  return source === "all" ? entries : entries.filter((entry) => entry.source === source);
}
