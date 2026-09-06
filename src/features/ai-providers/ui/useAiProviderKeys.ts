import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import type { AiProvidersGateway, ProviderCode } from "../application/ports";

export function notifyAiProviderError(error: Error) {
  const messages: Record<string, string> = {
    AI_USER_KEY_INVALID: "That API key is invalid. Check the key and try again.",
    AI_PROVIDER_UNREACHABLE: "The provider is temporarily unreachable. Try again later.",
    AI_CONNECTION_REQUIRED: "Connect a key for this provider first.",
    "429": "Too many requests. Please wait before trying again.",
    AI_RATE_LIMITED: "Too many requests. Please wait before trying again.",
  };
  toast({ title: "Could not update AI settings", description: messages[error.message] ?? "Please try again. Your changes could not be saved.", variant: "destructive" });
}

export function useAiProviderKeys(gateway: AiProvidersGateway, userId: string) {
  const client = useQueryClient();
  const queryKey = ["ai-provider-keys", userId];
  const query = useQuery({ queryKey, queryFn: () => gateway.listKeys(), enabled: !!userId });
  const [isSaving, setIsSaving] = useState(false);
  const invalidate = () => client.invalidateQueries({ queryKey });
  // A raw credential must never be a TanStack mutation variable or cached result.
  async function saveKey(provider: ProviderCode, key: string) {
    setIsSaving(true);
    try {
      await gateway.saveKey(provider, key);
      void invalidate();
      toast({ title: "AI key saved" });
    } catch (error) {
      notifyAiProviderError(error as Error);
      throw error;
    } finally {
      setIsSaving(false);
    }
  }
  const test = useMutation({
    mutationFn: (provider: ProviderCode) => gateway.testKey(provider),
    onSuccess: () => toast({ title: "AI key verified" }),
    onError: notifyAiProviderError,
    onSettled: invalidate,
  });
  const remove = useMutation({
    mutationFn: (provider: ProviderCode) => gateway.deleteKey(provider),
    onSuccess: () => toast({ title: "AI key removed" }),
    onError: notifyAiProviderError,
    onSettled: invalidate,
  });
  return { ...query, saveKey, isSaving, test, remove };
}
