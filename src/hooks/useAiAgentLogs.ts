/* eslint-disable @typescript-eslint/no-explicit-any */
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";

export interface AiAgentLog {
  id: string;
  platform: string | null;
  conversation_id: string | null;
  inbound_text: string | null;
  reply_text: string | null;
  tool_calls: Array<{ name: string; arguments: unknown }> | null;
  prompt_tokens: number | null;
  completion_tokens: number | null;
  latency_ms: number | null;
  status: string | null;
  error: string | null;
  created_at: string;
}

export function useAiAgentLogs(platform: AiAgentPlatform) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["ai-agent-logs", platform],
    enabled: !!session,
    refetchInterval: 15000,
    queryFn: async () => {
      const { data, error } = await (supabase as any)
        .from("ai_agent_logs")
        .select("*")
        .eq("platform", platform)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return data as AiAgentLog[];
    },
  });
}
