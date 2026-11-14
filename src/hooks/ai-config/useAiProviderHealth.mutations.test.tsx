import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDisconnectAiOAuth, useFinishAiOAuth } from "./useAiProviderAuth";
import { useProviderHealthStatus } from "./useAiProviderHealth";
import { useSetServiceKey, useToggleProvider } from "../useAIConfiguration";

const { invoke, getSession } = vi.hoisted(() => ({ invoke: vi.fn(), getSession: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke }, auth: { getSession } },
}));

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, wrapper };
}

describe("provider configuration changes refresh mounted health", () => {
  beforeEach(() => {
    invoke.mockReset();
    getSession.mockResolvedValue({ data: { session: { access_token: crypto.randomUUID() } } });
  });
  afterEach(() => vi.unstubAllGlobals());

  it.each(["finish", "disconnect"] as const)("refreshes health after OAuth %s", async (action) => {
    let changed = false;
    invoke.mockImplementation(async (name: string) => {
      if (name === "ai-provider-health") return { data: { results: changed ? [] : [
        { provider_code: "claude", auth_method: "oauth", status: "connected" },
      ] }, error: null };
      changed = true;
      return { data: { status: action === "finish" ? "connected" : "not_connected", account_label: null }, error: null };
    });
    const { wrapper, client } = queryWrapper();
    const { result, unmount } = renderHook(() => ({
      health: useProviderHealthStatus(), finish: useFinishAiOAuth(), disconnect: useDisconnectAiOAuth(),
    }), { wrapper });
    await waitFor(() => expect(result.current.health.data).toHaveLength(1));
    await act(async () => {
      if (action === "finish") await result.current.finish.mutateAsync({ provider: "anthropic", pasted: "code#state" });
      else await result.current.disconnect.mutateAsync("anthropic");
    });
    await waitFor(() => expect(result.current.health.data).toEqual([]));
    unmount();
    client.clear();
  });

  it.each(["key save", "provider toggle"] as const)("refreshes health after %s", async (action) => {
    let changed = false;
    invoke.mockImplementation(async (name: string) => {
      if (name === "ai-provider-health") return { data: { results: changed ? [] : [
        { provider_code: "openai", auth_method: "api_key", status: "connected" },
      ] }, error: null };
      changed = true;
      return { data: { success: true }, error: null };
    });
    vi.stubGlobal("fetch", vi.fn(async () => {
      changed = true;
      return new Response(JSON.stringify({ success: true }), { status: 200 });
    }));
    const { wrapper, client } = queryWrapper();
    const { result, unmount } = renderHook(() => ({
      health: useProviderHealthStatus(), save: useSetServiceKey(), toggle: useToggleProvider(),
    }), { wrapper });
    await waitFor(() => expect(result.current.health.data).toHaveLength(1));
    await act(async () => {
      if (action === "key save") await result.current.save.mutateAsync({ provider_code: "openai", api_key: crypto.randomUUID() });
      else await result.current.toggle.mutateAsync({ provider_id: "provider-fixture", is_active: false });
    });
    await waitFor(() => expect(result.current.health.data).toEqual([]));
    unmount();
    client.clear();
  });
});
