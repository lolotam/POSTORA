import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { callEdgeApi } from "@/lib/messagingApi";
import type { AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import type { WebsiteSetupJob } from "@/lib/websiteSetup";

export function useWebsiteSetup(platform: AiAgentPlatform, accountId: string) {
  const { user } = useAuth();
  const client = useQueryClient();
  const queryKey = ["website-setup", user?.id, platform, accountId];
  const query = useQuery({
    queryKey,
    enabled: !!user && !!accountId,
    queryFn: async () => {
      const response = await callEdgeApi("ai-website-setup", "list", {
        platform, social_account_id: accountId,
      });
      return response.jobs as WebsiteSetupJob[];
    },
    refetchInterval: 5000,
  });
  const refresh = () => client.invalidateQueries({ queryKey });
  const request = useMutation({
    mutationFn: (sourceId: string) => callEdgeApi("ai-website-setup", "request", {
      platform, social_account_id: accountId, source_id: sourceId,
    }),
    onSuccess: refresh,
  });
  const retry = useMutation({
    mutationFn: (jobId: string) => callEdgeApi("ai-website-setup", "retry", { job_id: jobId }),
    onSuccess: refresh,
  });
  const apply = useMutation({
    mutationFn: (input: { job_id: string; fields: string[]; expected_config_updated_at: string | null }) =>
      callEdgeApi("ai-website-setup", "apply", input),
    onSuccess: () => Promise.all([
      refresh(),
      client.invalidateQueries({ queryKey: ["ai-agent-config", user?.id, platform, accountId] }),
      client.invalidateQueries({ queryKey: ["ai-knowledge-sources", user?.id] }),
    ]),
    onError: () => client.invalidateQueries({ queryKey: ["ai-agent-config", user?.id, platform, accountId] }),
  });
  return { ...query, request, retry, apply };
}
