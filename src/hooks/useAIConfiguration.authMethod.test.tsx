import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { upsert, invoke } = vi.hoisted(() => ({ upsert: vi.fn(), invoke: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: vi.fn(() => ({ upsert })), functions: { invoke } },
}));

import { useSetDefaultModel, useSetFallback2Model, useSetFallbackModel } from "@/hooks/useAIConfiguration";
import { CHAT_LIST_POLICY_QUERY_KEY } from '@/features/ai-providers/infrastructure/chatListGateway';

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}

describe("tier setters and auth_method", () => {
  beforeEach(() => {
    upsert.mockReset();
    upsert.mockResolvedValue({ error: null });
    invoke.mockReset();
    invoke.mockResolvedValue({ data: { success: true }, error: null });
  });

  it.each([
    ['primary', useSetDefaultModel], ['fallback', useSetFallbackModel], ['fallback_2', useSetFallback2Model],
  ] as const)('flagged %s saves use the authoritative boundary instead of direct writes', async (slot, useSetter) => {
    const { client, wrapper } = queryWrapper();
    client.setQueryData(CHAT_LIST_POLICY_QUERY_KEY, { enabled: true, groups: [] });
    const { result } = renderHook(() => useSetter(), { wrapper });
    await result.current.mutateAsync({ category: 'chat', provider_code: 'claude', model_id: 'same', auth_method: 'oauth' });
    expect(invoke).toHaveBeenCalledWith('ai-config', { body: { action: 'set-chat-tier', category: 'chat', slot, provider_code: 'claude', model_id: 'same', auth_method: 'oauth' }, timeout: 30_000 });
    expect(upsert).not.toHaveBeenCalled();
  });

  it('retains cached saved tiers when the server refuses a save', async () => {
    const { client, wrapper } = queryWrapper();
    const saved = { categoryDefaults: { chat: { provider_code: 'claude', model_id: 'previous', auth_method: 'oauth' } } };
    client.setQueryData(['ai-config'], saved);
    client.setQueryData(CHAT_LIST_POLICY_QUERY_KEY, { enabled: true, groups: [] });
    invoke.mockResolvedValue({ data: { error: 'configuration_changed_retry' }, error: null });
    const { result } = renderHook(() => useSetDefaultModel(), { wrapper });
    await expect(result.current.mutateAsync({ category: 'chat', provider_code: 'claude', model_id: 'draft' })).rejects.toThrow(/Retry/);
    expect(client.getQueryData(['ai-config'])).toEqual(saved);
    expect(upsert).not.toHaveBeenCalled();
  });

  it('never coerces an unknown explicit authentication value to API', async () => {
    const { wrapper } = queryWrapper();
    const { result } = renderHook(() => useSetDefaultModel(), { wrapper });
    const untrusted = JSON.parse('{"category":"chat","provider_code":"claude","model_id":"same","auth_method":"unknown"}');
    await expect(result.current.mutateAsync(untrusted)).rejects.toThrow('Unknown authentication method');
    expect(upsert).not.toHaveBeenCalled();
  });

  it("writes auth_method when the tier is served by a subscription", async () => {
    const { wrapper } = queryWrapper();

    const { result } = renderHook(() => useSetDefaultModel(), { wrapper });
    await result.current.mutateAsync({
      provider_code: "claude",
      model_id: "claude-sonnet-4-5",
      category: "chat",
      auth_method: "oauth",
    });

    expect(upsert).toHaveBeenCalledTimes(1);
    const row = upsert.mock.calls[0][0];
    expect(row.key).toBe("default_ai_model_chat");
    expect(row.value).toEqual({ provider_code: "claude", model_id: "claude-sonnet-4-5", auth_method: "oauth" });
  });

  it("writes exactly provider_code and model_id when no auth_method is given", async () => {
    const { wrapper } = queryWrapper();

    const { result } = renderHook(() => useSetDefaultModel(), { wrapper });
    await result.current.mutateAsync({
      provider_code: "openai",
      model_id: "gpt-4o-mini",
      category: "chat",
    });

    const row = upsert.mock.calls[0][0];
    expect(row.value).toEqual({ provider_code: "openai", model_id: "gpt-4o-mini" });
    expect(Object.keys(row.value)).toHaveLength(2);
  });

  it("omits auth_method when it is api_key, keeping old rows byte-identical", async () => {
    const { wrapper } = queryWrapper();

    const { result } = renderHook(() => useSetDefaultModel(), { wrapper });
    await result.current.mutateAsync({
      provider_code: "openai",
      model_id: "gpt-4o-mini",
      category: "chat",
      auth_method: "api_key",
    });

    const row = upsert.mock.calls[0][0];
    expect(row.value).toEqual({ provider_code: "openai", model_id: "gpt-4o-mini" });
    expect(Object.keys(row.value)).toHaveLength(2);
  });

  it("carries auth_method on the fallback and fallback-2 tiers too", async () => {
    const { wrapper } = queryWrapper();

    const fallback = renderHook(() => useSetFallbackModel(), { wrapper });
    await fallback.result.current.mutateAsync({
      provider_code: "claude",
      model_id: "claude-opus-5",
      category: "chat",
      auth_method: "oauth",
    });
    expect(upsert.mock.calls[0][0].key).toBe("default_ai_model_chat_fallback");
    expect(upsert.mock.calls[0][0].value).toEqual({
      provider_code: "claude",
      model_id: "claude-opus-5",
      auth_method: "oauth",
    });

    upsert.mockClear();

    const fallback2 = renderHook(() => useSetFallback2Model(), { wrapper });
    await fallback2.result.current.mutateAsync({
      provider_code: "claude",
      model_id: "claude-sonnet-4-5",
      category: "chat",
      auth_method: "oauth",
    });
    expect(upsert.mock.calls[0][0].key).toBe("default_ai_model_chat_fallback_2");
    expect(upsert.mock.calls[0][0].value).toEqual({
      provider_code: "claude",
      model_id: "claude-sonnet-4-5",
      auth_method: "oauth",
    });
  });
});

describe("parseSettingsRows carries auth_method", () => {
  it("keeps a saved oauth tier readable by the dropdown", async () => {
    const { parseSettingsRows } = await import("@/hooks/useAIConfiguration");
    const parsed = parseSettingsRows([
      { key: "default_ai_model_chat", value: { provider_code: "claude", model_id: "claude-sonnet-4-5", auth_method: "oauth" } },
    ]);

    expect(parsed.categoryDefaults.chat?.auth_method).toBe("oauth");
  });

  it("leaves an api-key tier without an auth_method key", async () => {
    const { parseSettingsRows } = await import("@/hooks/useAIConfiguration");
    const parsed = parseSettingsRows([
      { key: "default_ai_model_chat", value: { provider_code: "openai", model_id: "gpt-4o-mini" } },
    ]);

    expect(parsed.categoryDefaults.chat?.auth_method).toBeUndefined();
    expect(parsed.categoryDefaults.chat).toEqual({ provider_code: "openai", model_id: "gpt-4o-mini" });
  });
});
