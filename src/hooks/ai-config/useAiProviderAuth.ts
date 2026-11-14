import { CHAT_LIST_POLICY_QUERY_KEY } from '@/features/ai-providers/infrastructure/chatListGateway';
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AI_PROVIDER_HEALTH_QUERY_KEY } from "./queryKeys";
import {
  aiProviderAuthGateway,
  type AiOAuthCapabilities,
  type OAuthProviderId,
} from "@/features/ai-providers/infrastructure/aiProviderAuthGateway";

export type { AiOAuthCapabilities, OAuthProviderId };

/** One cache identity for every subscription-auth read and write. */
export const AI_PROVIDER_AUTH_QUERY_KEY = ["ai-provider-auth"] as const;

export function useAiProviderAuthCapabilities({ enabled = true }: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: AI_PROVIDER_AUTH_QUERY_KEY,
    queryFn: () => aiProviderAuthGateway.capabilities(),
    retry: false,
    enabled,
  });
}

export function useStartAiOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: OAuthProviderId) => aiProviderAuthGateway.start(provider),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_AUTH_QUERY_KEY });
    },
  });
}

export function useFinishAiOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, pasted }: { provider: OAuthProviderId; pasted: string }) =>
      aiProviderAuthGateway.finish(provider, pasted),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_AUTH_QUERY_KEY });
      // A finished login changes what the provider can answer, so the model
      // catalogue behind the provider's model list is read again too. Without
      // this the list stays on what it was before the login, and closing and
      // reopening the dialog shows the same stale rows.
      queryClient.invalidateQueries({ queryKey: ["ai-config"] });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY });
    },
  });
}

export function useDisconnectAiOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (provider: OAuthProviderId) => aiProviderAuthGateway.disconnect(provider),
    onSuccess: (_result, provider) => {
      // The server confirmed the delete, so the cache says so at once: a
      // refetch that fails afterwards must not leave the login shown as connected.
      queryClient.setQueryData<AiOAuthCapabilities>(AI_PROVIDER_AUTH_QUERY_KEY, (current) =>
        current && {
          ...current,
          providers: current.providers.map((p) =>
            p.oauth_provider === provider
              ? { ...p, status: "not_connected", account_label: null, expires_at: null }
              : p,
          ),
        },
      );
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_AUTH_QUERY_KEY });
      // A disconnected subscription can leave a tier pointing at a provider that
      // can no longer answer, so the tier list is refreshed too.
      queryClient.invalidateQueries({ queryKey: ["ai-config"] });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_HEALTH_QUERY_KEY });
    },
  });
}

export function useTestAiOAuth() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ provider, modelId }: { provider: OAuthProviderId; modelId: string }) =>
      aiProviderAuthGateway.test(provider, modelId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: CHAT_LIST_POLICY_QUERY_KEY });
      queryClient.invalidateQueries({ queryKey: AI_PROVIDER_AUTH_QUERY_KEY });
    },
  });
}
