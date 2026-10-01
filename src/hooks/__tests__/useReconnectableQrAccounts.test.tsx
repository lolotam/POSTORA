import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useReconnectableQrAccounts } from "@/hooks/useReconnectableQrAccounts";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "test-user-id" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
  },
}));

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

describe("useReconnectableQrAccounts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("queries social_accounts with expected filters: platform=whatsapp, connection_mode=evolution_qr, is_active=false, not pending_%, not retired_%, ordered by updated_at desc", async () => {
    const mockAccounts = [
      {
        id: "qr-acc-1",
        platform_user_id: "96597950350",
        platform_username: "Support WhatsApp",
        connection_mode: "evolution_qr",
        updated_at: "2026-10-01T12:00:00Z",
      },
    ];

    const chain: Record<string, any> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.not = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockResolvedValue({ data: mockAccounts, error: null });

    vi.mocked(supabase.from).mockReturnValue(chain as any);

    const { result } = renderHook(() => useReconnectableQrAccounts(), { wrapper });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(mockAccounts);

    expect(supabase.from).toHaveBeenCalledWith("social_accounts");
    expect(chain.select).toHaveBeenCalledWith(
      "id, platform_user_id, platform_username, connection_mode, updated_at",
    );
    expect(chain.eq).toHaveBeenCalledWith("platform", "whatsapp");
    expect(chain.eq).toHaveBeenCalledWith("connection_mode", "evolution_qr");
    expect(chain.eq).toHaveBeenCalledWith("is_active", false);
    expect(chain.not).toHaveBeenCalledWith("platform_user_id", "like", "pending_%");
    expect(chain.not).toHaveBeenCalledWith("platform_user_id", "like", "retired_%");
    expect(chain.order).toHaveBeenCalledWith("updated_at", { ascending: false });
  });

  it("surfaces an error as isError when query fails", async () => {
    const chain: Record<string, any> = {};
    chain.select = vi.fn().mockReturnValue(chain);
    chain.eq = vi.fn().mockReturnValue(chain);
    chain.not = vi.fn().mockReturnValue(chain);
    chain.order = vi.fn().mockResolvedValue({
      data: null,
      error: { message: "Failed to load reconnectable accounts" },
    });

    vi.mocked(supabase.from).mockReturnValue(chain as any);

    const { result } = renderHook(() => useReconnectableQrAccounts(), { wrapper });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toBeDefined();
  });
});
