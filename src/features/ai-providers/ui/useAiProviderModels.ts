import { useQuery } from "@tanstack/react-query";
import type { AiProvidersGateway } from "../application/ports";

export function useAiProviderModels(gateway: AiProvidersGateway) {
  return useQuery({ queryKey: ["ai-provider-models"], queryFn: () => gateway.listModels() });
}
