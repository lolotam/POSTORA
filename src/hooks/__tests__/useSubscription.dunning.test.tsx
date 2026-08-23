import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useSubscription } from "../useSubscription";
import { supabase } from "@/integrations/supabase/client";

// C1 (2026-08-23 final review): dunning must not silently downgrade a
// paying customer. Stripe keeps a subscription "past_due" (not cancelled)
// for the whole payment-retry window, and effective_user_quotas() now
// entitles 'active' OR 'past_due' — this hook's own DB read must resolve
// the same population, or the UI disagrees with what quota checks actually
// enforce.

vi.mock("../useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    session: { access_token: "token-1" },
  }),
}));

vi.mock("../useUserRole", () => ({
  useUserRole: () => ({ isSubscriber: false, isAdmin: false }),
}));

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    from: vi.fn(),
  },
}));

interface ChainCall {
  method: string;
  args: unknown[];
}

function makeChain(result: { data: unknown; error?: unknown }) {
  const calls: ChainCall[] = [];
  const chain: any = {};
  for (const method of ["select", "eq", "in", "order", "limit"]) {
    chain[method] = (...args: unknown[]) => {
      calls.push({ method, args });
      return chain;
    };
  }
  chain.maybeSingle = () => Promise.resolve(result);
  chain.single = () => Promise.resolve(result);
  return { chain, calls };
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, refetchInterval: false } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

describe("useSubscription — dunning entitlement", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (supabase.functions.invoke as any).mockResolvedValue({ data: null, error: null });
  });

  it("treats a past_due db subscription as subscribed, not downgraded to free", async () => {
    const subChain = makeChain({
      data: {
        id: "sub-1",
        user_id: "user-1",
        plan_id: "plan-1",
        status: "past_due",
        current_period_end: null,
        cancel_at_period_end: false,
      },
      error: null,
    });
    const planChain = makeChain({
      data: {
        id: "plan-1",
        name: "Pro",
        slug: "pro",
        price_monthly: 9,
        price_yearly: 90,
        profile_limit: 15,
        features: [],
      },
      error: null,
    });

    (supabase.from as any).mockImplementation((table: string) => {
      if (table === "user_subscriptions") return subChain.chain;
      if (table === "subscription_plans") return planChain.chain;
      throw new Error(`unexpected table ${table}`);
    });

    const { result } = renderHook(() => useSubscription(), { wrapper: createWrapper() });

    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isSubscribed).toBe(true);
    expect(result.current.planSlug).toBe("pro");
    expect(result.current.isFree).toBe(false);

    // The status filter must include past_due alongside active, not active alone.
    const statusFilter = subChain.calls.find((c) => c.args[0] === "status");
    expect(statusFilter?.method).toBe("in");
    expect(statusFilter?.args[1]).toEqual(["active", "past_due"]);
  });

  it("orders by the arbiter's own tie-break and limits to one row (maybeSingle trap)", async () => {
    // A user with two rows matching the widened predicate (one active, one
    // past_due from an old Stripe subscription) must still resolve
    // deterministically — an unordered IN(...) with .maybeSingle() throws
    // on 2 rows, which would make this hook fall back to "unsubscribed".
    const subChain = makeChain({ data: null, error: null });
    (supabase.from as any).mockImplementation((table: string) => {
      if (table === "user_subscriptions") return subChain.chain;
      throw new Error(`unexpected table ${table}`);
    });

    const { result } = renderHook(() => useSubscription(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    const orderCalls = subChain.calls.filter((c) => c.method === "order").map((c) => c.args);
    expect(orderCalls).toEqual([
      ["current_period_end", { ascending: false, nullsFirst: false }],
      ["created_at", { ascending: false }],
      ["id", { ascending: false }],
    ]);
    const limitCall = subChain.calls.find((c) => c.method === "limit");
    expect(limitCall?.args).toEqual([1]);
  });
});
