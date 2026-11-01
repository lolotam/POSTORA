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
