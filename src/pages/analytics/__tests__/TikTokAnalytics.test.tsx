import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import TikTokAnalytics from "../TikTokAnalytics";
import type { BrandPost, BrandProfile } from "@/types/brand-intelligence";

const PROFILE: BrandProfile = {
  id: "t1", username: "northwind", fullName: "Northwind", bio: "", avatarUrl: "",
  followersCount: 1, followingCount: 1, postsCount: 2, isVerified: false, platform: "tiktok",
};
const POST: BrandPost = {
  id: "p1", mediaType: "VIDEO", thumbnailUrl: "", caption: "", likesCount: 1, commentsCount: 0, engagementScore: 1,
  timestamp: "2026-10-30T08:00:00Z", permalink: "https://www.tiktok.com/@northwind/video/1", videoViewCount: 5,
};
const base = { profile: PROFILE, posts: [POST], totalPosts: 2, hasMore: true, isLoading: false, error: null, loadMore: vi.fn() };

const state = vi.hoisted(() => ({
  source: "apify" as "apify" | "tiktok_api",
  apify: {} as Record<string, unknown>,
  api: {} as Record<string, unknown>,
}));

vi.mock("@/components/layout/DashboardLayout", () => ({ DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/analytics/TikTokAccountSelector", () => ({ TikTokAccountSelector: () => null }));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ session: { access_token: "t", user: { id: "u1" } } }) }));
vi.mock("@/hooks/useTikTokAnalyticsSource", () => ({ useTikTokAnalyticsSource: () => ({ source: state.source, isLoading: false }) }));
vi.mock("@/hooks/useBrandScrape", () => ({ useBrandScrape: () => ({ ...state.apify, search: vi.fn(), reset: vi.fn() }) }));
vi.mock("@/hooks/useTikTokApiAnalytics", () => ({ useTikTokApiAnalytics: () => state.api }));
vi.mock("@/integrations/supabase/client", () => {
  const rows: { data: unknown[] } = { data: [] };
  const query: Record<string, unknown> = {};
  for (const name of ["select", "eq"]) query[name] = () => query;
  query.then = (resolve: (value: typeof rows) => unknown) => resolve(rows);
  return { supabase: { from: () => query } };
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}><MemoryRouter><TikTokAnalytics /></MemoryRouter></QueryClientProvider>);
}

beforeEach(() => { state.source = "apify"; state.apify = { ...base }; state.api = { ...base, errorCode: undefined }; });

describe("TikTok page load more", () => {
  it("disables Load More and shows the loading label while the Apify source loads a further page", () => {
    state.apify = { ...base, isLoadingMore: true, loadMoreError: null };
    renderPage();
    expect(screen.getByRole("button", { name: /Loading/i })).toBeDisabled();
  });

  it("keeps the loaded posts and shows the translated failure when a later Apify page fails", () => {
    state.apify = { ...base, isLoadingMore: false, loadMoreError: "unavailable" };
    renderPage();
    expect(screen.getByText("Could not load more. Try again.")).toBeInTheDocument();
    expect(screen.getByText("❤️ 1")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Load More" })).toBeEnabled();
  });

  it("ignores stale Apify continuation state while the API source is active", () => {
    state.source = "tiktok_api";
    state.apify = { ...base, isLoadingMore: true, loadMoreError: "unavailable" };
    renderPage();
    expect(screen.getByRole("button", { name: "Load More" })).toBeEnabled();
    expect(screen.queryByText("Could not load more. Try again.")).not.toBeInTheDocument();
  });
});
