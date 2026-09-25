import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Labels and assignments can be created server-side by the AI agent, so an
// open inbox keeps both queries refreshing: every 30s and on window focus.

const db = vi.hoisted(() => ({ from: vi.fn(), eq: vi.fn(), order: vi.fn() }));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: { from: (...args: unknown[]) => db.from(...args) },
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ session: { user: { id: "user-1" } } }),
}));

import { useWhatsAppLabels } from "@/hooks/useWhatsAppLabels";

function renderHookWithClient() {
  // refetchOnWindowFocus defaults to false here so the assertions prove the
  // hook asks for refetching itself, rather than inheriting the client default.
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  return { client, ...renderHook(() => useWhatsAppLabels(), { wrapper }) };
}

describe("useWhatsAppLabels query refresh options", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Both queries chain select().eq() and (labels only) .order(); the eq
    // result must be awaitable for the assignments query.
    db.from.mockReturnValue({
      select: vi.fn(() => ({ eq: db.eq })),
    });
    db.eq.mockReturnValue({
      order: db.order,
      then: (resolve: (v: unknown) => unknown, reject: (v: unknown) => unknown) =>
        Promise.resolve({ data: [], error: null }).then(resolve, reject),
    });
    db.order.mockResolvedValue({ data: [], error: null });
  });

  it("refreshes labels and assignments every 30s and on window focus", async () => {
    const { client, result } = renderHookWithClient();

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    // refetchInterval/refetchOnWindowFocus live on the observer's options,
    // already resolved against the client defaults.
    const labels = client.getQueryCache().find({ queryKey: ["whatsapp-labels", "user-1"] })?.observers[0]?.options;
    const assignments = client.getQueryCache().find({ queryKey: ["whatsapp-label-assignments", "user-1"] })?.observers[0]?.options;

    expect(labels?.refetchInterval).toBe(30_000);
    expect(labels?.refetchOnWindowFocus).toBe(true);
    expect(assignments?.refetchInterval).toBe(30_000);
    expect(assignments?.refetchOnWindowFocus).toBe(true);
  });
});
