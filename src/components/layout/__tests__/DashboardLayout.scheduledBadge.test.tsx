import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

const queryMode = vi.hoisted(() => ({ error: false, count: 0 }));

// The review branch hides the Scheduled link; this test covers the normal nav.
vi.mock("@/config/tiktokReviewMode", () => ({ TIKTOK_REVIEW_MODE: false }));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === "string" ? fallback : key),
  }),
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "user-1" },
    profile: { full_name: "Ada", email: "ada@example.com" },
    signOut: vi.fn(),
  }),
}));

vi.mock("@/hooks/useUserRole", () => ({
  useUserRole: () => ({ isAdmin: false }),
}));

vi.mock("@/hooks/useSubscription", () => ({
  useSubscription: () => ({ planName: "Free", isPro: false, isBusiness: false, isFree: true }),
}));

vi.mock("@/contexts/PublishingContext", () => ({
  usePublishing: () => ({ publishingPosts: [], isPublishing: false }),
}));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: new Proxy({}, { get: () => false }), isLoading: false }),
}));

vi.mock("@/components/PublishingStatusWidget", () => ({ PublishingStatusWidget: () => null }));
vi.mock("@/components/CreditBalanceIndicator", () => ({ CreditBalanceIndicator: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/LanguageToggle", () => ({ LanguageToggle: () => null }));
vi.mock("@/components/Logo", () => ({ Logo: () => null }));

vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

const WARNING = "Couldn't load the scheduled count";

function countBuilder() {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    gt: () => builder,
    then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) => {
      const outcome = queryMode.error
        ? { count: null, error: { message: "timeout" } }
        : { count: queryMode.count, error: null };
      return Promise.resolve(outcome).then(resolve, reject);
    },
  };
  return builder;
}

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>
      <MemoryRouter>{children}</MemoryRouter>
    </QueryClientProvider>
  );
  return { client, ...render(<DashboardLayout><div>page</div></DashboardLayout>, { wrapper }) };
}

describe("scheduled nav count", () => {
  beforeEach(() => {
    queryMode.error = false;
    queryMode.count = 0;
    vi.mocked(supabase.from).mockImplementation(() => countBuilder() as never);
  });

  it("shows a warning when the first count load fails, then keeps the last number", async () => {
    queryMode.error = true;
    const { client } = renderLayout();
    expect(await screen.findByRole("img", { name: WARNING })).toBeInTheDocument();

    queryMode.error = false;
    queryMode.count = 2;
    await client.refetchQueries({ queryKey: ["posts"] });
    await waitFor(() => expect(screen.getByText("4")).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: WARNING })).not.toBeInTheDocument();

    queryMode.error = true;
    await client.refetchQueries({ queryKey: ["posts"] });
    await waitFor(() => expect(screen.getByText("4")).toBeInTheDocument());
    expect(screen.queryByRole("img", { name: WARNING })).not.toBeInTheDocument();
  });
});
