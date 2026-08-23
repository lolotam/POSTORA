import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useQuotas } from "../useQuotas";
import { useSubscription } from "../useSubscription";
import { supabase } from "@/integrations/supabase/client";

// R2/R3 (CodeRabbit round 2, 2026-08-23): F6 (round 1) added
// getReadyPlanLimits(), which awaits the subscription_plans and user_quotas
// (override) queries before an enforcement helper (canCreateProfile,
// canConnectSocialAccount, canCreatePost, canUploadMedia) decides. But
// `effectivePlanSlug` - the slug getReadyPlanLimits() looks up entitlements
// FOR - is derived from useSubscription(), which is ITSELF a pending
// react-query query on first render. While it is pending, isSubscribed
// defaults to false, so effectivePlanSlug defaults to "free": the round-1
// fix dutifully awaited the FREE plan row and handed Free-tier limits to a
// paying (Pro) user whose subscription simply had not loaded yet. The
// readiness gate closed the wrong window.
//
// This test forces exactly that race: useSubscription() starts pending
// (isLoading: true, isSubscribed: false), canUploadMedia() is invoked
// immediately (before the subscription settles), and only THEN does
// useSubscription() flip to its settled Pro values. A correct fix must wait
// for that settlement before deciding, so the outcome must reflect the Pro
// limit - never the Free one.

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

describe("useQuotas() awaits the subscription query itself, not just the plan/override queries (R2/R3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (useSubscription as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      planSlug: "free",
      isSubscribed: false,
      isLoading: true,
    });

    // subscription_plans: slug-sensitive, so the assertion below proves
    // WHICH slug was actually queried, not just that some data came back.
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
      // user_quotas (override) and everything else: no override, resolves
      // immediately.
      return makeQueryBuilder(Promise.resolve({ data: null, error: null, count: 0 }));
    });

    // Denied, so the helper must build the message from the resolved limit.
    (supabase.rpc as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({ data: false, error: null });
  });

  it("waits for the subscription query to settle instead of deciding against the free plan slug", async () => {
    const { result, rerender } = renderHook(() => useQuotas(), { wrapper: createWrapper() });

    // Called immediately - useSubscription() is still pending (isLoading:
    // true, isSubscribed: false) at the moment of this call. A fix must NOT
    // resolve effectivePlanSlug to "free" and decide off that.
    const outcomePromise = result.current.canUploadMedia();

    // Now the subscription query settles: Pro, not Free.
    (useSubscription as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
      planSlug: "pro",
      isSubscribed: true,
      isLoading: false,
    });
    act(() => {
      rerender();
    });

    const outcome = await outcomePromise;

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain(String(PRO_MEDIA_LIMIT));
    expect(outcome.message).not.toContain(`of ${FREE_MEDIA_LIMIT} media uploads`);
  });
});
