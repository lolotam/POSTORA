import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import type { AiProvidersGateway, Capability, RoutingPreference } from "../application/ports";
import { notifyAiProviderError } from "./useAiProviderKeys";

export function useAiRoutingPreferences(gateway: AiProvidersGateway, userId: string) {
  const client = useQueryClient();
  const queryKey = ["ai-routing-prefs", userId];
  const query = useQuery({ queryKey, queryFn: () => gateway.getPreferences(), enabled: !!userId });
  const onSuccess = () => {
    toast({ title: "Routing saved" });
    return client.invalidateQueries({ queryKey });
  };
  const save = useMutation({ mutationFn: (pref: RoutingPreference) => gateway.upsertPreference(pref), onSuccess, onError: notifyAiProviderError });
  const remove = useMutation({ mutationFn: (capability: Capability) => gateway.deletePreference(capability), onSuccess, onError: notifyAiProviderError });
  return { ...query, save, remove };
}
