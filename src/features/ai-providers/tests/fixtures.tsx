import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { vi } from "vitest";
import type { AiProvidersGateway, KeyStatus, ProviderModel } from "../application/ports";

export const connectedKey: KeyStatus = {
  id: "key-1", user_id: "user-1", provider_code: "openai", key_hint: "1234",
  status: "active", last_verified_at: "2026-09-06T10:00:00Z",
};
export const model: ProviderModel = { id: "model-1", model_id: "gpt-test", name: "Test model", provider_code: "openai" };

export function fakeGateway() {
  return {
    listKeys: vi.fn<AiProvidersGateway["listKeys"]>().mockResolvedValue([connectedKey]),
    saveKey: vi.fn<AiProvidersGateway["saveKey"]>().mockResolvedValue(connectedKey),
    testKey: vi.fn<AiProvidersGateway["testKey"]>().mockResolvedValue(connectedKey),
    deleteKey: vi.fn<AiProvidersGateway["deleteKey"]>().mockResolvedValue(undefined),
    joinWaitlist: vi.fn<AiProvidersGateway["joinWaitlist"]>().mockResolvedValue(undefined),
    isOnWaitlist: vi.fn<AiProvidersGateway["isOnWaitlist"]>().mockResolvedValue(false),
    getPreferences: vi.fn<AiProvidersGateway["getPreferences"]>().mockResolvedValue([]),
    upsertPreference: vi.fn<AiProvidersGateway["upsertPreference"]>().mockResolvedValue(undefined),
    deletePreference: vi.fn<AiProvidersGateway["deletePreference"]>().mockResolvedValue(undefined),
    listModels: vi.fn<AiProvidersGateway["listModels"]>().mockResolvedValue([model]),
  };
}

export function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}
