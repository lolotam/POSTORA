import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useSetupMovePreview } from "@/hooks/useSetupMovePreview";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
  },
}));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
    },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("useSetupMovePreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not call rpc when from or to is null", async () => {
    renderHook(() => useSetupMovePreview(null, "acc-to"), {
      wrapper: createWrapper(),
    });
    expect(supabase.rpc).not.toHaveBeenCalled();

    renderHook(() => useSetupMovePreview("acc-from", null), {
      wrapper: createWrapper(),
    });
    expect(supabase.rpc).not.toHaveBeenCalled();
  });

  it("calls get_whatsapp_setup_move_preview once when both ids are set and returns preview data on success", async () => {
    const mockPreview = {
      same_workspace: true,
      source_has_agent: true,
      destination_has_agent: false,
      connectors: [
        {
          name: "woo_store",
          connector_type: "woocommerce",
          has_store_webhook: true,
          name_clash: false,
          destination_has_store_webhook: false,
        },
      ],
      partner_items: 0,
      waitlist_count: 0,
      waitlist_moves: true,
      template_count: 0,
      templates_move: true,
    };

    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: mockPreview,
      error: null,
    } as never);

    const { result } = renderHook(() => useSetupMovePreview("acc-from", "acc-to"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 500 });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("get_whatsapp_setup_move_preview", {
      p_from: "acc-from",
      p_to: "acc-to",
    });
    expect(result.current.data).toEqual(mockPreview);
  });

  it("sets isError to true when rpc returns an error", async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "get_whatsapp_setup_move_preview: not found" },
    } as never);

    const { result } = renderHook(() => useSetupMovePreview("acc-from", "acc-to"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 500 });
    expect(result.current.error).toBeDefined();
  });
});
