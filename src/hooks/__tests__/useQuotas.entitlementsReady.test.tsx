import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { useQuotas } from "../useQuotas";
import { supabase } from "@/integrations/supabase/client";

// F6 (CodeRabbit round 1, 2026-08-23): on first render, before the
// subscription_plans / user_quotas queries have resolved, `planLimits`
// used to be `resolvePlanLimits(undefined, undefined)` === FREE_TIER_FALLBACK
// (2/3/30/2/20) — a small hardcoded placeholder that has nothing to do with
// the user's real plan. canConnectSocialAccount() / canUploadMedia() read
// that placeholder directly, so a Pro/Business user calling either helper
// in that window could be denied against Free-tier numbers instead of
// their real (much higher) plan limits.
//
// This test forces the "still loading" window by delaying the
// subscription_plans query so it has NOT resolved by the time
// canUploadMedia() is invoked, then asserts the helper's decision still
// reflects the REAL (delayed) plan limit, not the Free-tier fallback —
// proving it awaited readiness instead of deciding off placeholder data.

vi.mock("../useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" } }),
}));

vi.mock("../useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("../useSubscription", () => ({
  useSubscription: () => ({ planSlug: "pro", isSubscribed: true, isLoading: false }),
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

const REAL_PRO_MEDIA_LIMIT = 500; // far above FREE_TIER_FALLBACK.max_media_uploads_per_day (20)

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

describe("useQuotas() entitlement readiness (F6)", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    (supabase.from as unknown as Mock).mockImplementation((table: string) => {
      if (table === "subscription_plans") {
        // Deliberately delayed: still pending when canUploadMedia() below
        // is invoked immediately after render.
        const delayed = new Promise<{ data: unknown; error: unknown }>((resolve) => {
          setTimeout(
            () =>
              resolve({
                data: {
                  profile_limit: 15,
                  max_social_accounts: 30,
                  max_posts_per_month: 500,
                  max_posts_per_day: 30,
                  max_media_uploads_per_day: REAL_PRO_MEDIA_LIMIT,
                },
                error: null,
              }),
            30,
          );
        });
        return makeQueryBuilder(delayed);
      }
      // user_quotas (override) and everything else: resolve immediately
      // with "no override" / empty.
      return makeQueryBuilder(Promise.resolve({ data: null, error: null, count: 0 }));
    });

    // Denied, so the helper must build the message from the resolved limit.
    (supabase.rpc as unknown as Mock).mockResolvedValue({ data: false, error: null });
  });

  it("canUploadMedia() decides against the real (delayed) plan limit, not the Free-tier fallback", async () => {
    const { result } = renderHook(() => useQuotas(), { wrapper: createWrapper() });

    // Called immediately - the subscription_plans query has NOT resolved
    // yet (it is on a 30ms timer). A fix must await real entitlement data
    // before deciding, rather than reading the FREE_TIER_FALLBACK-seeded
    // `planLimits` snapshot taken at this render.
    const outcome = await result.current.canUploadMedia();

    expect(outcome.allowed).toBe(false);
    expect(outcome.message).toContain(String(REAL_PRO_MEDIA_LIMIT));
    expect(outcome.message).not.toContain("of 20 media uploads");
  });
});
