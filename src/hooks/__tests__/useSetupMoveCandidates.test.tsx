import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useSetupMoveCandidates } from "@/hooks/useSetupMoveCandidates";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-test-123" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    rpc: vi.fn(),
    from: vi.fn().mockReturnValue({
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockReturnThis(),
      order: vi.fn().mockResolvedValue({ data: [], error: null }),
    }),
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

describe("useSetupMoveCandidates", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("null id → no rpc, data []", async () => {
    const { result } = renderHook(() => useSetupMoveCandidates(null), {
      wrapper: createWrapper(),
    });

    expect(supabase.rpc).not.toHaveBeenCalled();
    expect(result.current.data).toEqual([]);
  });

  it("success → exact rpc call and data equals the rpc result (wait for isSuccess before asserting)", async () => {
    const mockCandidates = [
      {
        id: "cand-1",
        platform_username: "xsellpoint (old)",
        reason: "same_number",
        summary: {
          agent_config: 1,
          connectors: 1,
          connector_links: 0,
          store_bindings: 1,
          knowledge_sources: 5,
          test_cases: 0,
          waitlist: 0,
          templates: 0,
          partner_keys_primary: 0,
          partner_key_links: 0,
          partner_webhooks: 0,
          n8n_subscriptions: 0,
          scheduled_messages: 0,
          automation_handlers: [],
        },
      },
    ];

    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: mockCandidates,
      error: null,
    } as never);

    const { result } = renderHook(() => useSetupMoveCandidates("acc-active-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true), { timeout: 500 });

    expect(supabase.rpc).toHaveBeenCalledTimes(1);
    expect(supabase.rpc).toHaveBeenCalledWith("list_whatsapp_setup_move_candidates", {
      p_to: "acc-active-1",
    });
    expect(result.current.data).toEqual(mockCandidates);
  });

  it("rpc {error} → isError true (retries off)", async () => {
    vi.mocked(supabase.rpc).mockResolvedValueOnce({
      data: null,
      error: { code: "42501", message: "list_whatsapp_setup_move_candidates: not found" },
    } as never);

    const { result } = renderHook(() => useSetupMoveCandidates("acc-active-1"), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true), { timeout: 500 });
    // A failed read must not look like "nothing to move".
    expect(result.current.data).toBeUndefined();
  });
});
