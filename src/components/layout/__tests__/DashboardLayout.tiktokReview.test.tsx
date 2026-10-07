import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardLayout } from "@/components/layout/DashboardLayout";

const role = vi.hoisted(() => ({ isAdmin: false }));

vi.mock("@/config/tiktokReviewMode", () => ({ TIKTOK_REVIEW_MODE: true }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, fallback?: string) => (typeof fallback === "string" ? fallback : key),
  }),
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ user: { id: "user-1" }, profile: { full_name: "Ada", email: "ada@example.com" }, signOut: vi.fn() }),
}));
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: role.isAdmin }) }));
vi.mock("@/hooks/useSubscription", () => ({
  useSubscription: () => ({ planName: "Free", isPro: false, isBusiness: false, isFree: true }),
}));
vi.mock("@/contexts/PublishingContext", () => ({
  usePublishing: () => ({ publishingPosts: [], isPublishing: false }),
}));
// Every flag on, so a hidden menu is hidden by review mode and not by a flag.
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: new Proxy({}, { get: () => true }), isLoading: false }),
}));
vi.mock("@/hooks/usePosts", () => ({
  useScheduledPostCount: () => ({ data: 0, isError: false }),
}));
vi.mock("@/components/PublishingStatusWidget", () => ({ PublishingStatusWidget: () => null }));
vi.mock("@/components/CreditBalanceIndicator", () => ({ CreditBalanceIndicator: () => null }));
vi.mock("@/components/NotificationBell", () => ({ NotificationBell: () => null }));
vi.mock("@/components/ThemeToggle", () => ({ ThemeToggle: () => null }));
vi.mock("@/components/LanguageToggle", () => ({ LanguageToggle: () => null }));
vi.mock("@/components/Logo", () => ({ Logo: () => null }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

function renderLayout() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <DashboardLayout><div>page</div></DashboardLayout>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DashboardLayout in TikTok review mode", () => {
  beforeEach(() => {
    role.isAdmin = false;
  });

  it("shows a non-admin only History and TikTok Management", () => {
    renderLayout();
    expect(screen.getByRole("link", { name: /TikTok Management/ })).toHaveAttribute("href", "/tiktok-publish");
    expect(screen.getByRole("link", { name: /History/ })).toHaveAttribute("href", "/history");
    for (const hidden of ["Publishing", "Create Post", "Users", "Analytics", "Automation", "Ad Manager"]) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }
  });

  it("keeps the full nav for an admin", () => {
    role.isAdmin = true;
    renderLayout();
    for (const shown of ["Publishing", "Users", "Analytics", "Automation", "Ad Manager"]) {
      expect(screen.getAllByText(shown).length).toBeGreaterThan(0);
    }
    expect(screen.queryByText("TikTok Management")).not.toBeInTheDocument();
  });
});
