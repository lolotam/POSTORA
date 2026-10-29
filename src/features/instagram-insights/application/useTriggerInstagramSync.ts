import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import type { InstagramInsightsGateway, TriggerSyncResult } from "./ports";

export type UseTriggerInstagramSyncOptions = {
  gateway: InstagramInsightsGateway;
  onSuccess?: (result: TriggerSyncResult) => void;
  onError?: (error: Error) => void;
};

export function useTriggerInstagramSync({
  gateway,
  onSuccess,
  onError,
}: UseTriggerInstagramSyncOptions) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const userId = user?.id ?? "anonymous";

  return useMutation<TriggerSyncResult, Error, { socialAccountId: string }>({
    mutationFn: async ({ socialAccountId }) => {
      return gateway.triggerSync({ socialAccountId });
    },
    onSuccess: (result, variables) => {
      // Invalidate all report queries for this user and account so freshness updates
      void queryClient.invalidateQueries({
        queryKey: ["instagram-insights-report", userId, variables.socialAccountId],
      });
      onSuccess?.(result);
    },
    onError: (error) => {
      onError?.(error);
    },
  });
}
