import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { fetchAgentDashboard, fetchModelPrices } from "../../infrastructure/agentDashboardApi";

export type DashboardWindow = 7 | 30;

/**
 * The signed-in user's agent aggregates for the last `days`, optionally one platform.
 * Keyed by user: the QueryClient outlives a sign-out, and a cached dashboard must not
 * be shown to the next person who signs in on the same tab.
 */
export function useAgentDashboard(days: DashboardWindow, platform: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["ai-agent-dashboard", user?.id, platform, days],
    queryFn: () => fetchAgentDashboard(days, platform),
    enabled: !!user,
    staleTime: 60_000,
  });
}

/** Catalogue prices change rarely; one fetch per session is plenty. */
export function useModelPrices() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["ai-model-prices"],
    queryFn: fetchModelPrices,
    enabled: !!user,
    staleTime: 60 * 60_000,
  });
}
