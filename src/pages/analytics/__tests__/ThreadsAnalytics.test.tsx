import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import ThreadsAnalytics from "../ThreadsAnalytics";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({
    user: { id: "test-user-id" },
    session: { access_token: "test-token", user: { id: "test-user-id" } },
  }),
}));

vi.mock("@/hooks/useOwnedThreadsAccounts", () => ({
  useOwnedThreadsAccounts: () => ({
    accounts: [],
    ownedUsernames: new Set<string>(),
    ownsUsername: () => null,
  }),
}));

vi.mock("@/hooks/useThreadsLiveDiscovery", () => ({
  useThreadsLiveDiscovery: () => ({
    profile: null,
    posts: [],
    totalPosts: 0,
    hasMore: false,
    isLoading: false,
    errorState: null,
    requestSource: null,
    search: vi.fn(),
    reset: vi.fn(),
    removePostId: vi.fn(),
  }),
}));

vi.mock("@/components/brand-intelligence/ThreadsDiscoveryPanel", () => ({
  ThreadsDiscoveryPanel: () => <div data-testid="threads-discovery-panel" />,
}));

vi.mock("@/components/brand-intelligence/ThreadsKeywordSearchPanel", () => ({
  ThreadsKeywordSearchPanel: () => <div data-testid="threads-keyword-search-panel" />,
}));

vi.mock("@/features/analytics-contract/ui/OwnedAnalyticsScreen", () => ({
  OwnedAnalyticsScreen: ({ platform }: { platform: string }) => (
    <div data-testid="owned-analytics-screen" data-platform={platform}>
      Owned Analytics Screen Mock
    </div>
  ),
}));

vi.mock("@/integrations/supabase/client", () => {
  const rows: { data: unknown[] } = { data: [] };
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq"]) query[name] = () => query;
  query.then = (resolve: (value: typeof rows) => unknown) => resolve(rows);
  return { supabase: { from: () => query, functions: { invoke: vi.fn() } } };
});

function renderPage(initialEntries = ["/analytics/threads"]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={initialEntries}>
        <Routes>
          <Route path="/analytics/threads" element={<ThreadsAnalytics />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("ThreadsAnalytics Insights tab lazy mounting (Issue #351)", () => {
  it("does not mount OwnedAnalyticsScreen on initial visit to the default analyze tab", () => {
    renderPage(["/analytics/threads"]);

    expect(screen.queryByTestId("owned-analytics-screen")).not.toBeInTheDocument();
  });

  it("mounts OwnedAnalyticsScreen with platform='threads' when the Insights tab is clicked and keeps it mounted across tab switches", () => {
    renderPage(["/analytics/threads"]);

    expect(screen.queryByTestId("owned-analytics-screen")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /Insights/i }));

    const ownedScreen = screen.getByTestId("owned-analytics-screen");
    expect(ownedScreen).toBeInTheDocument();
    expect(ownedScreen).toHaveAttribute("data-platform", "threads");

    fireEvent.click(screen.getByRole("button", { name: /Keyword Search/i }));
    expect(screen.getByTestId("owned-analytics-screen")).toBeInTheDocument();
  });

  it("mounts OwnedAnalyticsScreen immediately when opened with ?tab=insights", () => {
    renderPage(["/analytics/threads?tab=insights"]);

    const ownedScreen = screen.getByTestId("owned-analytics-screen");
    expect(ownedScreen).toBeInTheDocument();
    expect(ownedScreen).toHaveAttribute("data-platform", "threads");
  });
});
