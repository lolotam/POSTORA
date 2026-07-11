/* eslint-disable @typescript-eslint/no-explicit-any */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

export interface AllowedAiModel {
  id: string;
  provider: string;
  model_id: string;
  label: string;
  is_active: boolean;
  sort_order: number;
}

export function formatAllowedModelValue(model: Pick<AllowedAiModel, "provider" | "model_id">) {
  return `${model.provider}/${model.model_id}`;
}

export function useAllowedAiAgentModels(includeInactive = false) {
  const { session } = useAuth();
  return useQuery({
    queryKey: ["ai-agent-allowed-models", includeInactive],
    enabled: !!session,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      let query = (supabase as any)
        .from("ai_agent_allowed_models")
        .select("*")
        .order("sort_order", { ascending: true });
      if (!includeInactive) query = query.eq("is_active", true);
      const { data, error } = await query;
      if (error) throw error;
      return (data || []) as AllowedAiModel[];
    },
  });
}
