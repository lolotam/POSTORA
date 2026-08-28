import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useWhatsAppReconnect } from "@/hooks/useWhatsAppConnect";

const invoke = vi.hoisted(() => vi.fn());
const toastSpy = vi.hoisted(() => vi.fn());

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { functions: { invoke } },
}));
vi.mock("@/hooks/use-toast", () => ({ toast: toastSpy }));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useWhatsAppReconnect", () => {
  beforeEach(() => {
    invoke.mockReset();
    toastSpy.mockReset();
  });

  it("asks whatsapp-oauth to reconnect the named account", async () => {
    invoke.mockResolvedValue({ data: { success: true, teardown: { graph: "ok" } }, error: null });
    const { result } = renderHook(() => useWhatsAppReconnect(), { wrapper });

    result.current.mutate("acc-1");

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(invoke).toHaveBeenCalledWith("whatsapp-oauth", {
      body: { action: "reconnect", social_account_id: "acc-1" },
    });
  });

  it("surfaces a failed reconnect instead of reporting success", async () => {
    // The failure that matters: the edge function refuses when it could not
    // resubscribe, and the operator must see that rather than a green toast on
    // an account that still receives nothing.
    invoke.mockResolvedValue({ data: null, error: { message: "Could not resubscribe" } });
    const { result } = renderHook(() => useWhatsAppReconnect(), { wrapper });

    result.current.mutate("acc-2");

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(toastSpy).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Reconnect failed", variant: "destructive" }),
    );
  });

  it("treats a 200 carrying an error body as a failure", async () => {
    // The edge functions in this codebase can answer 200 with {error}; taking
    // response.ok at face value would report a dead account as reconnected.
    invoke.mockResolvedValue({ data: { error: "Account has no access token" }, error: null });
    const { result } = renderHook(() => useWhatsAppReconnect(), { wrapper });

    result.current.mutate("acc-3");

    await waitFor(() => expect(result.current.isError).toBe(true));
  });
});
