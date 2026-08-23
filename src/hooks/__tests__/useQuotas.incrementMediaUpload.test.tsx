import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useQuotas } from "../useQuotas";
import { supabase } from "@/integrations/supabase/client";

// F1 (CodeRabbit round 1, 2026-08-23): increment_media_uploads() is an
// atomic RPC that both checks and increments the daily counter. When it
// errors — e.g. two concurrent FIRST uploads both hit the missing-row
// branch and the second loses the user_quotas.user_id unique-key race —
// the RPC call itself fails. That failure must never be read as "the quota
// check passed, go ahead and upload"; the upload that triggered this call
// has NOT been recorded, and the caller must not treat it as counted/allowed.

vi.mock("../useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("../useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("../useSubscription", () => ({
  useSubscription: () => ({ planSlug: "free", isSubscribed: false }),
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

function makeQueryBuilder(result: { data: unknown; error: unknown; count?: number }) {
  const resolved = Promise.resolve(result);
  const builder = {
    select: () => builder,
    eq: () => builder,
    gte: () => builder,
    order: () => builder,
    in: () => builder,
    maybeSingle: () => resolved,
    single: () => resolved,
    then: (
      onFulfilled: (value: typeof result) => unknown,
      onRejected?: (reason: unknown) => unknown,
    ) => resolved.then(onFulfilled, onRejected),
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

describe("useQuotas().incrementMediaUpload — RPC error handling (F1)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (supabase.from as unknown as Mock).mockImplementation(() =>
      makeQueryBuilder({ data: null, error: null, count: 0 }),
    );
  });

  it("does NOT treat an increment_media_uploads RPC error as permission to upload", async () => {
    (supabase.rpc as unknown as Mock).mockResolvedValue({
      data: null,
      error: {
        message:
          'duplicate key value violates unique constraint "user_quotas_user_id_key"',
      },
    });

    const { result } = renderHook(() => useQuotas(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const allowed = await result.current.incrementMediaUpload();

    expect(allowed).toBe(false);
  });

  it("still returns true when the RPC succeeds and reports true", async () => {
    (supabase.rpc as unknown as Mock).mockResolvedValue({ data: true, error: null });

    const { result } = renderHook(() => useQuotas(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const allowed = await result.current.incrementMediaUpload();

    expect(allowed).toBe(true);
  });
});
