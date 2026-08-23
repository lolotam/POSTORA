import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useQuotas } from "../useQuotas";
import { useSubscription } from "../useSubscription";
import { supabase } from "@/integrations/supabase/client";

// R3 (CodeRabbit round 3, 2026-08-23): the effect that keeps
// isSubscriptionLoadingRef / effectivePlanSlugRef current now depends on
// BOTH isSubscriptionLoading and effectivePlanSlug (it has to - the ref
// mirroring effectivePlanSlug must stay current when that value changes on
// its own, e.g. once useSubscription() resolves to a different slug while
// still loading a step further). That widened dependency array is exactly
// where a NAIVE version of the "move the writes into an effect" fix
// reintroduces a bug: if that same effect ALSO returns
// flushSubscriptionReadyWaiters as its cleanup, the cleanup fires on ANY
// dependency change - including a render where effectivePlanSlug changes
// while isSubscriptionLoading is STILL true - which wakes a queued waiter
// before the subscription has actually settled.
//
// This is why the fix keeps the unmount-only flush in its OWN effect with an
// empty dependency array, and the value-storing effect returns no cleanup at
// all. This test locks that shape in: it proves a waiter queued while
// isSubscriptionLoading is true stays pending across a render where the
// value effect re-runs (effectivePlanSlug changed) but isSubscriptionLoading
// has not, and only resolves once isSubscriptionLoading actually settles.
//
// Provability note (see coderabbit-round3-report.md): this exact sequence
// cannot be made to fail against the pre-fix HEAD implementation, because
// HEAD's effect depended on isSubscriptionLoading ALONE - a render where only
// effectivePlanSlug changes never touches that effect at all, so HEAD never
// even attempts a premature flush for this input. This test instead guards
// the CORRECT fix's shape against the naive one-effect variant, which is the
// actual hazard the two-effect design exists to prevent. It was verified to
// fail against that naive variant and pass against the shipped fix (see the
// report for verbatim output).

vi.mock("../useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("../useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("../useSubscription", () => ({
  useSubscription: vi.fn(),
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

const FREE_MEDIA_LIMIT = 20; // matches FREE_TIER_FALLBACK.max_media_uploads_per_day
const PRO_MEDIA_LIMIT = 500; // far above the Free-tier fallback

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

describe("useQuotas() flushes waiters only once the subscription actually settles (R3 cleanup ordering)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (useSubscription as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      planSlug: "free",
      isSubscribed: false,
      isLoading: true,
    });

    (supabase.from as unknown as ReturnType<typeof vi.fn>).mockImplementation((table: string) => {
      if (table === "subscription_plans") {
        let capturedSlug: string | undefined;
        const builder = {
          select: () => builder,
          eq: (_col: string, value: string) => {
            capturedSlug = value;
            return builder;
          },
          maybeSingle: () =>
            Promise.resolve({
              data:
                capturedSlug === "pro"
                  ? {
                      profile_limit: 15,
                      max_social_accounts: 30,
                      max_posts_per_month: 500,
                      max_posts_per_day: 30,
                      max_media_uploads_per_day: PRO_MEDIA_LIMIT,
                    }
                  : {
                      profile_limit: 2,
                      max_social_accounts: 3,
                      max_posts_per_month: 30,
                      max_posts_per_day: 2,
                      max_media_uploads_per_day: FREE_MEDIA_LIMIT,
                    },
              error: null,
            }),
        };
        return builder;
      }
      return makeQueryBuilder(Promise.resolve({ data: null, error: null, count: 0 }));
    });

    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: false, error: null });
  });

  it("does not wake a queued waiter when the effect re-runs for a slug change while still loading", async () => {
    const { result, rerender } = renderHook(() => useQuotas(), { wrapper: createWrapper() });

    // Queued while isSubscriptionLoading is true.
    const outcomePromise = result.current.canUploadMedia();

    let settled = false;
    outcomePromise.then(() => {
      settled = true;
    });

    // isSubscriptionLoading stays true, but effectivePlanSlug changes
    // ("free" -> "pro") - this is a real react-query/useSubscription shape:
    // isSubscribed can flip true a render before isLoading catches up to
    // false. The value-storing effect's dependency array includes
    // effectivePlanSlug, so it re-runs here.
    (useSubscription as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      planSlug: "pro",
      isSubscribed: true,
      isLoading: true,
    });
    await act(async () => {
      rerender();
      // Flush a couple of microtask turns - long enough for a wrongly-fired
      // flush to resolve the outcome promise, but no real settle has
      // happened yet.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(settled).toBe(false);

    // Now the subscription actually settles.
    (useSubscription as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      planSlug: "pro",
      isSubscribed: true,
      isLoading: false,
    });
    await act(async () => {
      rerender();
    });

    const outcome = await outcomePromise;

    expect(settled).toBe(true);
    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain(String(PRO_MEDIA_LIMIT));
    expect(outcome.message).not.toContain(`of ${FREE_MEDIA_LIMIT} media uploads`);
  });
});
