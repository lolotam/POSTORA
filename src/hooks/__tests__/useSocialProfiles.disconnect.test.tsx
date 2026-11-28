import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useDisconnectAccountFromProfile } from "../useSocialProfiles";
import { supabase } from "@/integrations/supabase/client";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    functions: {
      invoke: vi.fn(),
    },
  },
}));

const createWrapper = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
      },
    },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

describe("useDisconnectAccountFromProfile — Issue #253 (WhatsApp disconnect & account-scoped connectors)", () => {
  const invoke = supabase.functions.invoke as unknown as Mock;
  const from = supabase.from as unknown as Mock;
  let toolsDeleteEq: Mock;
  let accountDeleteEq: Mock;

  const mockTables = (
    accountRow: { platform: string; auth_provider?: string; connection_mode?: string | null } | null,
    toolsError: Error | null = null,
    accountDeleteError: Error | null = null,
  ) => {
    toolsDeleteEq = vi.fn(async () => ({ error: toolsError }));
    accountDeleteEq = vi.fn(async () => ({ error: accountDeleteError }));

    from.mockImplementation((table: string) => {
      if (table === "ai_agent_tools") {
        return {
          delete: vi.fn(() => ({ eq: toolsDeleteEq })),
        };
      }
      if (table === "social_accounts") {
        return {
          select: vi.fn(() => ({
            eq: vi.fn(() => ({
              maybeSingle: vi.fn(async () => ({
                data: accountRow,
                error: null,
              })),
            })),
          })),
          delete: vi.fn(() => ({ eq: accountDeleteEq })),
        };
      }
      throw new Error(`Unexpected table: ${table}`);
    });
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls whatsapp-oauth disconnect before deleting ai_agent_tools and social_accounts for an Evolution QR WhatsApp account", async () => {
    mockTables({ platform: "whatsapp", connection_mode: "evolution_qr" });
    invoke.mockResolvedValue({ data: { success: true }, error: null });

    const { result } = renderHook(() => useDisconnectAccountFromProfile(), {
      wrapper: createWrapper(),
    });
    await result.current.mutateAsync("acc-wa-1");

    expect(invoke).toHaveBeenCalledWith("whatsapp-oauth", {
      body: { action: "disconnect", social_account_id: "acc-wa-1" },
    });
    expect(toolsDeleteEq).toHaveBeenCalledWith("social_account_id", "acc-wa-1");
    expect(accountDeleteEq).toHaveBeenCalledWith("id", "acc-wa-1");
    expect(invoke.mock.invocationCallOrder[0]).toBeLessThan(
      toolsDeleteEq.mock.invocationCallOrder[0],
    );
    expect(toolsDeleteEq.mock.invocationCallOrder[0]).toBeLessThan(
      accountDeleteEq.mock.invocationCallOrder[0],
    );
  });

  it("aborts deletion when whatsapp-oauth disconnect fails for an Evolution QR account", async () => {
    mockTables({ platform: "whatsapp", connection_mode: "evolution_qr" });
    invoke.mockResolvedValue({ data: null, error: new Error("Not authorized to disconnect") });

    const { result } = renderHook(() => useDisconnectAccountFromProfile(), {
      wrapper: createWrapper(),
    });
    await expect(result.current.mutateAsync("acc-wa-2")).rejects.toThrow("Not authorized to disconnect");

    expect(invoke).toHaveBeenCalledWith("whatsapp-oauth", {
      body: { action: "disconnect", social_account_id: "acc-wa-2" },
    });
    expect(toolsDeleteEq).not.toHaveBeenCalled();
    expect(accountDeleteEq).not.toHaveBeenCalled();
  });

  it("does not call whatsapp-oauth disconnect for Meta-hosted WhatsApp accounts so sibling WABA numbers stay subscribed", async () => {
    mockTables({ platform: "whatsapp", connection_mode: "coexistence" });

    const { result } = renderHook(() => useDisconnectAccountFromProfile(), {
      wrapper: createWrapper(),
    });
    await result.current.mutateAsync("acc-wa-meta");

    expect(invoke).not.toHaveBeenCalled();
    expect(toolsDeleteEq).toHaveBeenCalledWith("social_account_id", "acc-wa-meta");
    expect(accountDeleteEq).toHaveBeenCalledWith("id", "acc-wa-meta");
  });

  it("aborts and rejects without deleting social_accounts when ai_agent_tools deletion fails", async () => {
    const toolsFailure = new Error("RLS or DB error deleting connectors");
    mockTables({ platform: "instagram" }, toolsFailure);
    invoke.mockResolvedValue({ data: { success: true }, error: null });

    const { result } = renderHook(() => useDisconnectAccountFromProfile(), {
      wrapper: createWrapper(),
    });

    await expect(result.current.mutateAsync("acc-ig-1")).rejects.toThrow(
      "RLS or DB error deleting connectors",
    );
    expect(toolsDeleteEq).toHaveBeenCalledWith("social_account_id", "acc-ig-1");
    expect(accountDeleteEq).not.toHaveBeenCalled();
  });
});
