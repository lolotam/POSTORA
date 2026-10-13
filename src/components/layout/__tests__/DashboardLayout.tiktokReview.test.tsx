import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
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
vi.mock("@/hooks/useUserRole", () => ({ useUserRole: () => ({ isAdmin: role.isAdmin, isLoading: false }) }));
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
vi.mock("@/features/tiktok-publishing/infrastructure/supabaseReviewGateway", () => ({
  createSupabaseReviewGateway: () => ({
    listAccounts: async () => [{ id: "acct-1", username: "creator", avatarUrl: null }],
    list: async (_accountId: string, state: string) =>
      state === "pending_review" ? [{ id: "d1", updatedAt: "2026-10-14T10:00:00Z" }, { id: "d2", updatedAt: "2026-10-14T09:00:00Z" }] : [],
  }),
}));

function LocationProbe() {
  return <span data-testid="location">{useLocation().pathname}</span>;
}

function renderLayout(path = "/approvals") {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="*" element={<DashboardLayout><div>page</div><LocationProbe /></DashboardLayout>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("DashboardLayout in TikTok review mode", () => {
  beforeEach(() => {
    role.isAdmin = false;
    delete document.documentElement.dataset.shell;
  });

  it("gives a non-admin the review sidebar and nothing from the admin nav", async () => {
    renderLayout();
    const nav = screen.getByRole("complementary", { name: "Main navigation" });
    for (const [name, href] of [
      ["Activity", "/activity"],
      ["Calendar", "/calendar"],
      ["Approvals", "/approvals"],
      ["Workspace", "/settings"],
      ["Integrations", "/integrations"],
    ]) {
      expect(within(nav).getByRole("link", { name: new RegExp(name) })).toHaveAttribute("href", href);
    }
    for (const hidden of ["Publishing", "Create Post", "Users", "Analytics", "Automation", "Ad Manager", "History"]) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }
    expect(document.documentElement.dataset.shell).toBe("review");
    expect(await within(nav).findByLabelText("2 waiting for approval")).toHaveTextContent("2");
  });

  it("sends a non-admin away from a route outside the review build", () => {
    renderLayout("/dashboard");
    expect(screen.getByTestId("location")).toHaveTextContent("/approvals");
  });

  it("keeps the full nav and the existing theme for an admin", () => {
    role.isAdmin = true;
    renderLayout("/dashboard");
    for (const shown of ["Publishing", "Users", "Analytics", "Automation", "Ad Manager"]) {
      expect(screen.getAllByText(shown).length).toBeGreaterThan(0);
    }
    expect(screen.queryByRole("complementary", { name: "Main navigation" })).not.toBeInTheDocument();
    expect(screen.getByTestId("location")).toHaveTextContent("/dashboard");
    expect(document.documentElement.dataset.shell).toBeUndefined();
  });
});
