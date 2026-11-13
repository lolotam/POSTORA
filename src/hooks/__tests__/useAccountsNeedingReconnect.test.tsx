import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useAccountsNeedingReconnect } from "@/hooks/useAccountsNeedingReconnect";

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "test-user-id" } }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
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

// Thenable stand-in for the Supabase query builder the hook awaits. Each builder records the
// filters it was given and resolves with the result queued for it, so the two queries the hook
// runs can be told apart.
interface FakeQueryBuilder {
  eqCalls: Array<[string, unknown]>;
  select: Mock;
  eq: Mock;
  then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => Promise<unknown>;
}

describe("useAccountsNeedingReconnect", () => {
  let builders: FakeQueryBuilder[];
  let results: Array<{ data: unknown; error: unknown }>;

  beforeEach(() => {
    vi.clearAllMocks();
    builders = [];
    results = [
      { data: [], error: null },
      { data: [], error: null },
    ];

    (supabase.from as Mock).mockImplementation(() => {
      const builder: FakeQueryBuilder = {
        eqCalls: [],
        select: vi.fn().mockReturnThis(),
        eq: vi.fn(),
        then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
          const result = results[builders.indexOf(builder)] ?? { data: [], error: null };
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      builder.eq.mockImplementation((col: string, val: unknown) => {
        builder.eqCalls.push([col, val]);
        return builder;
      });
      builders.push(builder);
      return builder;
    });
  });

  it("queries the active accounts that need a reauth and the inactive WhatsApp QR accounts", async () => {
    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledTimes(2);
    expect(supabase.from).toHaveBeenCalledWith("social_accounts");

    expect(builders[0].eqCalls).toContainEqual(["is_active", true]);
    expect(builders[0].eqCalls).toContainEqual(["needs_reauth", true]);

    expect(builders[1].eqCalls).toContainEqual(["is_active", false]);
    expect(builders[1].eqCalls).toContainEqual(["platform", "whatsapp"]);
    expect(builders[1].eqCalls).toContainEqual(["connection_mode", "evolution_qr"]);
    expect(builders[1].eqCalls).toContainEqual(["needs_reauth", true]);
  });

  it("scopes every query to the signed-in user", async () => {
    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    for (const builder of builders) {
      expect(builder.eqCalls).toContainEqual(["user_id", "test-user-id"]);
    }
  });

  it("merges the results of both queries into one list", async () => {
    const active = { id: "acc-1", platform: "instagram", is_active: true };
    const whatsappQr = { id: "acc-2", platform: "whatsapp", is_active: false };
    results = [
      { data: [active], error: null },
      { data: [whatsappQr], error: null },
    ];

    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.accounts).toEqual([active, whatsappQr]);
    expect(result.current.data?.partialError).toBeNull();
  });

  it("returns an account once when both queries returned it", async () => {
    const account = { id: "acc-1", platform: "whatsapp", is_active: false };
    results = [
      { data: [account], error: null },
      { data: [account], error: null },
    ];

    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.accounts).toEqual([account]);
  });

  it("keeps the accounts that loaded when the WhatsApp QR query failed", async () => {
    // The WhatsApp QR query is the one that fails in production: it filters on
    // connection_mode, and a row that predates that column makes PostgREST reject the
    // whole query. Throwing there used to throw away the active accounts too, so the
    // banner showed nothing at all for an owner whose OAuth accounts DID need a
    // reconnect.
    const active = { id: "acc-1", platform: "instagram", is_active: true };
    results = [
      { data: [active], error: null },
      { data: null, error: new Error("qr query failed") },
    ];

    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.accounts).toEqual([active]);
    expect(result.current.data?.partialError).toEqual({ scope: "whatsapp_qr" });
  });

  it("keeps the WhatsApp QR accounts when the active query failed", async () => {
    const whatsappQr = { id: "acc-2", platform: "whatsapp", is_active: false };
    results = [
      { data: null, error: new Error("active query failed") },
      { data: [whatsappQr], error: null },
    ];

    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(result.current.data?.accounts).toEqual([whatsappQr]);
    expect(result.current.data?.partialError).toEqual({ scope: "active" });
  });

  it("fails the query when both queries failed", async () => {
    const dbError = new Error("db failure");
    results = [
      { data: null, error: dbError },
      { data: null, error: dbError },
    ];

    const { result } = renderHook(() => useAccountsNeedingReconnect(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(dbError);
  });
});
