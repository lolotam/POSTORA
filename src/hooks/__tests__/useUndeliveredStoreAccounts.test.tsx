import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { useUndeliveredStoreAccounts } from "@/hooks/useUndeliveredStoreAccounts";

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

describe("useUndeliveredStoreAccounts", () => {
  let eqCalls: Array<[string, unknown]>;
  let notCalls: Array<[string, string, unknown]>;
  let queryResult: { data: unknown; error: unknown };

  beforeEach(() => {
    vi.clearAllMocks();
    eqCalls = [];
    notCalls = [];
    queryResult = { data: [], error: null };

    const builder: any = {
      select: vi.fn().mockReturnThis(),
      eq: vi.fn().mockImplementation((col: string, val: unknown) => {
        eqCalls.push([col, val]);
        return builder;
      }),
      not: vi.fn().mockImplementation((col: string, op: string, val: unknown) => {
        notCalls.push([col, op, val]);
        return builder;
      }),
      then: (resolve: (val: unknown) => unknown, reject?: (err: unknown) => unknown) => {
        return Promise.resolve(queryResult).then(resolve, reject);
      },
    };

    vi.mocked(supabase.from).mockReturnValue(builder);
  });

  it("queries social_accounts for the user's flagged whatsapp accounts", async () => {
    const mockAccounts = [{ id: "acc-1", platform_username: "xsellpoint" }];
    queryResult = { data: mockAccounts, error: null };

    const { result } = renderHook(() => useUndeliveredStoreAccounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isSuccess).toBe(true));

    expect(supabase.from).toHaveBeenCalledWith("social_accounts");
    expect(eqCalls).toContainEqual(["user_id", "test-user-id"]);
    expect(eqCalls).toContainEqual(["platform", "whatsapp"]);
    expect(notCalls).toContainEqual([
      "account_metadata->undelivered_store_events",
      "is",
      null,
    ]);
    expect(result.current.data).toEqual(mockAccounts);
  });

  it("fails the query and surfaces the error when a supabase query error occurs", async () => {
    const dbError = new Error("db failure");
    queryResult = { data: null, error: dbError };

    const { result } = renderHook(() => useUndeliveredStoreAccounts(), {
      wrapper: createWrapper(),
    });

    await waitFor(() => expect(result.current.isError).toBe(true));
    expect(result.current.error).toEqual(dbError);
  });
});
