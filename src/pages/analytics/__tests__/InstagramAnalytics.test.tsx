import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import InstagramAnalytics from "../InstagramAnalytics";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-user-id" },
    session: { access_token: "test-token", user: { id: "test-user-id" } },
  }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      {
        id: "acc-1",
        platform: "instagram",
        platform_username: "creator1",
        is_active: true,
      },
    ],
    isLoading: false,
  }),
}));

vi.mock("@/features/instagram-insights", () => ({
  InstagramPerformanceScreen: () => <div data-testid="instagram-performance-screen">Performance Screen Mock</div>,
}));

vi.mock("@/hooks/useBrandScrape", () => ({
  useBrandScrape: () => ({
    profile: null,
    posts: [],
    totalPosts: 0,
    hasMore: false,
    isLoading: false,
    error: null,
    search: vi.fn(),
    loadMore: vi.fn(),
  }),
}));

function renderPage(initialEntries = ["/analytics/instagram"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/analytics/instagram" element={<InstagramAnalytics />} />
          <Route path="/analytics/instagram/performance" element={<InstagramAnalytics defaultTab="performance" />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("InstagramAnalytics page composition", () => {
  it("renders Performance & Insights tab by default", () => {
    renderPage(["/analytics/instagram"]);

    expect(screen.getByTestId("instagram-performance-screen")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Performance & Insights/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /Brand & Competitors/i })).toBeInTheDocument();
  });

  it("switches to Brand & Competitors when clicked", () => {
    renderPage(["/analytics/instagram"]);

    const competitorTab = screen.getByRole("button", { name: /Brand & Competitors/i });
    fireEvent.click(competitorTab);

    expect(screen.queryByTestId("instagram-performance-screen")).not.toBeInTheDocument();
    expect(screen.getByText(/Start by searching for a brand/i)).toBeInTheDocument();
  });

  it("honors ?tab=analyze URL search param", () => {
    renderPage(["/analytics/instagram?tab=analyze"]);

    expect(screen.queryByTestId("instagram-performance-screen")).not.toBeInTheDocument();
    expect(screen.getByText(/Start by searching for a brand/i)).toBeInTheDocument();
  });

  it("renders Performance when routed via /analytics/instagram/performance", () => {
    renderPage(["/analytics/instagram/performance"]);

    expect(screen.getByTestId("instagram-performance-screen")).toBeInTheDocument();
  });
});

describe("InstagramAnalytics load more", () => {
  it("disables Load More while a page loads and shows the translated failure without the raw message", async () => {
    vi.resetModules();
    const post = { id: "p1", mediaType: "IMAGE", thumbnailUrl: "", caption: "", likesCount: 1, commentsCount: 0, engagementScore: 1, timestamp: "2026-10-30T08:00:00Z", permalink: "https://www.instagram.com/p/1" };
    const profile = { id: "i1", username: "northwind", fullName: "Northwind", bio: "", avatarUrl: "", followersCount: 1, followingCount: 1, postsCount: 2, isVerified: false, platform: "instagram" };
    vi.doMock("@/hooks/useBrandScrape", () => ({
      useBrandScrape: () => ({ profile, profileSource: "unknown", posts: [post], totalPosts: 2, hasMore: true, isLoading: false, isLoadingMore: true,
        error: null, loadMoreError: "unavailable", warning: null, reconnectRequired: false, search: vi.fn(), loadMore: vi.fn(), loadFromSession: vi.fn() }),
    }));
    const { default: Page } = await import("../InstagramAnalytics");
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={["/analytics/instagram?tab=analyze"]}><Page /></MemoryRouter></QueryClientProvider>);
    expect(screen.getByRole("button", { name: /Loading/i })).toBeDisabled();
    expect(screen.getByText("Could not load more. Try again.")).toBeInTheDocument();
  });
});
