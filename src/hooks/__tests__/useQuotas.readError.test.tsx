import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useQuotas } from "../useQuotas";
import { supabase } from "@/integrations/supabase/client";

// Issue #239 Item 2 / ARCHITECTURE.md Rule 3 ("Never let a failed read look
// like an empty one"): when reading user_quotas("*") fails, useQuotas() must
// preserve the error state (isQuotaError === true, quotaError populated)
// rather than swallowing the error and returning null as a successful empty
// read.

vi.mock("../useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("../useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("../useSubscription", () => ({
  useSubscription: () => ({ planSlug: "free", isSubscribed: false, isLoading: false }),
}));

vi.mock("../use-toast", () => ({
  useToast: () => ({ toast: vi.fn() }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

function makeQueryBuilder(resultPromise: Promise<{ data: unknown; error: unknown; count?: number }>) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    order: () => builder,
    in: () => builder,
    maybeSingle: () => resultPromise,
    single: () => resultPromise,
    then: (
      onFulfilled: (value: { data: unknown; error: unknown; count?: number }) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => resultPromise.then(onFulfilled, onRejected),
  };
  return builder;
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useQuotas() read error propagation (Issue #239 Item 2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("sets isQuotaError === true and exposes quotaError when reading user_quotas fails", async () => {
    const dbError = new Error("db timeout");

    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "user_quotas") {
        let selectedColumns = "";
        const builder = {
          select: (cols: string) => {
            selectedColumns = cols;
            return builder;
          },
          eq: () => builder,
          maybeSingle: () =>
            selectedColumns === "*"
              ? Promise.resolve({ data: null, error: dbError })
              : Promise.resolve({ data: null, error: null }),
        };
        return builder;
      }
      return makeQueryBuilder(Promise.resolve({ data: null, error: null, count: 0 }));
    });

    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { result } = renderHook(() => useQuotas(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isQuotaError).toBe(true);
    expect(result.current.quotaError).toBe(dbError);
    expect(result.current.quota).toBeUndefined();

    consoleSpy.mockRestore();
  });

  it("keeps isQuotaError === false and quota === null when a new user has no user_quotas row yet", async () => {
    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation(() =>
      makeQueryBuilder(Promise.resolve({ data: null, error: null, count: 0 })),
    );

    const { result } = renderHook(() => useQuotas(), { wrapper: createWrapper() });

    await waitFor(() => {
      expect(result.current.isLoading).toBe(false);
    });

    expect(result.current.isQuotaError).toBe(false);
    expect(result.current.quotaError).toBeNull();
    expect(result.current.quota).toBeNull();
  });
});
