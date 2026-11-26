import { readFileSync } from "node:fs";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import YouTubeAnalytics from "@/pages/analytics/YouTubeAnalytics";
import { YouTubeVideoDetail } from "@/features/youtube-management/ui/YouTubeVideoDetail";

const flagState = vi.hoisted(() => ({ analyticsYoutube: false, loading: false }));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags: { analyticsYoutube: flagState.analyticsYoutube }, isLoading: flagState.loading }),
}));
vi.mock("@/hooks/useAuth", () => ({ useAuth: () => ({ user: { id: "user-fixture" } }) }));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [], isLoading: false, error: null, refetch: vi.fn() }),
}));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/youtube-analytics", () => ({
  YouTubeAnalyticsScreen: () => <div>YouTube analytics screen</div>,
}));

const video = {
  id: "videoAAAAAAA",
  channel_id: "UCfixturechannel000000001",
  title: "First video",
  description: "Body text",
  thumbnail_url: null,
  published_at: "2026-10-31T00:00:00Z",
  tags: [],
  category_id: "22",
  default_language: "ar",
  duration_iso8601: "PT4M13S",
  privacy_status: "public",
  upload_status: "processed",
  made_for_kids: false,
  statistics: { view_count: 10, like_count: 1, comment_count: 1 },
  url: "https://www.youtube.com/watch?v=videoAAAAAAA",
};

beforeEach(() => {
  flagState.analyticsYoutube = false;
  flagState.loading = false;
});

describe("feature flag route and sidebar", () => {
  it("redirects the page when the flag is off and renders it when on", async () => {
    const { unmount } = render(
      <MemoryRouter initialEntries={["/analytics/youtube"]}>
        <Routes>
          <Route path="/analytics/youtube" element={<YouTubeAnalytics />} />
          <Route path="/dashboard" element={<div>Dashboard</div>} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("Dashboard")).toBeInTheDocument();
    unmount();

    flagState.analyticsYoutube = true;
    render(
      <MemoryRouter initialEntries={["/analytics/youtube"]}>
        <Routes><Route path="/analytics/youtube" element={<YouTubeAnalytics />} /></Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByText("YouTube analytics screen")).toBeInTheDocument();
  });

  it("registers the route and makes the sidebar and admin-dark visibility follow the flag", () => {
    const routes = readFileSync("src/components/AnimatedRoutes.tsx", "utf8");
    const layout = readFileSync("src/components/layout/DashboardLayout.tsx", "utf8");
    const flags = readFileSync("src/hooks/useFeatureFlags.tsx", "utf8");
    expect(routes).toContain('path="/analytics/youtube"');
    expect(routes).toContain('import("@/pages/analytics/YouTubeAnalytics")');
    expect(layout).toContain('flags.analyticsYoutube ? [{ icon: Video, label: t("sidebar.youtube", "YouTube"), path: "/analytics/youtube" }]');
    expect(flags).toContain('"analyticsYoutube"');
    expect(flags).toContain('feature_analytics_youtube: "analyticsYoutube"');
    expect(flags).toContain('analyticsYoutube: globalFlagMap["feature_analytics_youtube"] ?? DEFAULT_FLAGS.analyticsYoutube');
  });
});

describe("YouTube video analytics cross-link", () => {
  async function renderDetail() {
    const i18n = createInstance();
    await i18n.init({ lng: "en", resources: { en: { accounts: {} } }, defaultNS: "accounts" });
    return render(
      <MemoryRouter>
        <I18nextProvider i18n={i18n}>
          <YouTubeVideoDetail video={video} fetchedAt="2026-11-20T10:00:00Z" accountId="account/fixture" />
        </I18nextProvider>
      </MemoryRouter>,
    );
  }

  it("is hidden when the flag is off", async () => {
    await renderDetail();
    expect(screen.queryByRole("link", { name: "View analytics" })).not.toBeInTheDocument();
  });

  it("links the video and account when the flag is on", async () => {
    flagState.analyticsYoutube = true;
    await renderDetail();
    expect(screen.getByRole("link", { name: "View analytics" }))
      .toHaveAttribute("href", "/analytics/youtube?video=videoAAAAAAA&account=account%2Ffixture");
  });
});
