import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke } },
}));

import { aiProviderAuthGateway, INVALID_RESPONSE } from "@/features/ai-providers/infrastructure/aiProviderAuthGateway";
import {
  useAiProviderAuthCapabilities,
  useDisconnectAiOAuth,
  useStartAiOAuth,
} from "./useAiProviderAuth";

function queryWrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return { client, wrapper: Wrapper };
}

describe("aiProviderAuthGateway", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("invokes ai-provider-auth with the start action body", async () => {
    invoke.mockResolvedValue({
      data: { authorize_url: "https://claude.ai/oauth/authorize?code=1" },
      error: null,
    });

    const result = await aiProviderAuthGateway.start("anthropic");

    expect(invoke).toHaveBeenCalledWith("ai-provider-auth", {
      body: { action: "start", oauth_provider: "anthropic" },
    });
    // An answer without flow comes from an edge function older than the
    // callback flow, so it is the paste flow.
    expect(result).toEqual({ authorize_url: "https://claude.ai/oauth/authorize?code=1", flow: "pkce_paste" });
  });

  it("sends the pasted address on finish", async () => {
    invoke.mockResolvedValue({ data: { status: "connected", account_label: null }, error: null });

    await aiProviderAuthGateway.finish("openai-codex", "http://localhost:1455/auth/callback?code=c&state=s");

    expect(invoke).toHaveBeenCalledWith("ai-provider-auth", {
      body: { action: "finish", oauth_provider: "openai-codex", pasted: "http://localhost:1455/auth/callback?code=c&state=s" },
    });
  });

  it("throws the server error message when the function refuses", async () => {
    const context = new Response(JSON.stringify({ error: "invalid_state" }), {
      status: 400,
      headers: { "content-type": "application/json" },
    });
    invoke.mockResolvedValue({ data: null, error: { context } });

    await expect(aiProviderAuthGateway.finish("anthropic", "code#state")).rejects.toThrow("invalid_state");
  });

  it.each([
    ["a capabilities answer without the provider list", "capabilities", { enabled: true }],
    ["a start answer whose authorize_url is not a URL", "start", { authorize_url: "not a url" }],
  ])("rejects %s instead of handing it to the UI", async (_label, action, data) => {
    invoke.mockResolvedValue({ data, error: null });

    const call = action === "start"
      ? aiProviderAuthGateway.start("anthropic")
      : aiProviderAuthGateway.capabilities();

    await expect(call).rejects.toThrow(INVALID_RESPONSE);
  });

  it("falls back to a generic message when the server sent no envelope", async () => {
    invoke.mockResolvedValue({ data: null, error: { message: "Edge Function returned a non-2xx status code" } });

    await expect(aiProviderAuthGateway.capabilities()).rejects.toThrow("AI_PROVIDER_AUTH_REQUEST_FAILED");
  });
});

describe("useAiProviderAuth", () => {
  beforeEach(() => {
    invoke.mockReset();
  });

  it("reads the capabilities under the ai-provider-auth query key", async () => {
    invoke.mockResolvedValue({
      data: { enabled: false, providers: [] },
      error: null,
    });
    const { wrapper } = queryWrapper();

    const { result } = renderHook(() => useAiProviderAuthCapabilities(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual({ enabled: false, providers: [] });
  });

  it("invalidates the capabilities query after a start", async () => {
    invoke.mockResolvedValue({ data: { authorize_url: "https://claude.ai/oauth/authorize" }, error: null });
    const { client, wrapper } = queryWrapper();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useStartAiOAuth(), { wrapper });
    await result.current.mutateAsync("anthropic");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai-provider-auth"] });
  });

  it("invalidates ai-config as well when a subscription is disconnected", async () => {
    invoke.mockResolvedValue({ data: { status: "not_connected" }, error: null });
    const { client, wrapper } = queryWrapper();
    const invalidate = vi.spyOn(client, "invalidateQueries");

    const { result } = renderHook(() => useDisconnectAiOAuth(), { wrapper });
    await result.current.mutateAsync("anthropic");

    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai-provider-auth"] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ["ai-config"] });
  });

  it("marks the subscription disconnected in the cache even if the refetch then fails", async () => {
    const { client, wrapper } = queryWrapper();
    const claude = {
      provider_code: "claude", oauth_provider: "anthropic", name: "Anthropic", active: true,
      status: "connected", account_label: "me@example.com", expires_at: null, models: [], flow: "pkce_paste",
    };
    client.setQueryData(["ai-provider-auth"], { enabled: true, providers: [claude] });
    invoke
      .mockResolvedValueOnce({ data: { status: "not_connected" }, error: null })
      .mockRejectedValue(new Error("network down"));

    const { result } = renderHook(() => useDisconnectAiOAuth(), { wrapper });
    await result.current.mutateAsync("anthropic");

    expect(client.getQueryData<{ providers: Array<{ status: string }> }>(["ai-provider-auth"])?.providers[0].status)
      .toBe("not_connected");
  });
});
