import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import YouTubeManagementPage from "@/pages/youtube/YouTubeManagementPage";

const flags = vi.hoisted(() => ({ youtubeManagement: true }));

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags, isLoading: false }),
}));
vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "acc-yt", platform: "youtube", platform_username: "My channel", avatar_url: null, auth_provider: "native" },
      { id: "acc-ig", platform: "instagram", platform_username: "ig", avatar_url: null, auth_provider: "native" },
    ],
    isLoading: false,
  }),
}));
vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/youtube-management", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/features/youtube-management")>()),
  YouTubeManagementScreen: ({ accounts }: { accounts: Array<{ id: string }> }) => (
    <div data-testid="youtube-screen">{accounts.map((account) => account.id).join(",")}</div>
  ),
}));

function renderAt() {
  return render(
    <MemoryRouter initialEntries={["/youtube"]}>
      <Routes>
        <Route path="/youtube" element={<YouTubeManagementPage />} />
        <Route path="/dashboard" element={<div>dashboard</div>} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("YouTube management wiring", () => {
  it("the page hands only YouTube accounts to the feature's public screen", () => {
    flags.youtubeManagement = true;
    renderAt();
    expect(screen.getByTestId("youtube-screen")).toHaveTextContent("acc-yt");
    expect(screen.getByTestId("youtube-screen")).not.toHaveTextContent("acc-ig");
  });

  it("the page sends a user without the flag to the dashboard", () => {
    flags.youtubeManagement = false;
    renderAt();
    expect(screen.getByText("dashboard")).toBeInTheDocument();
    expect(screen.queryByTestId("youtube-screen")).not.toBeInTheDocument();
  });

  it("the application registers the route and a flag-gated sidebar entry", () => {
    const routes = readFileSync("src/components/AnimatedRoutes.tsx", "utf8");
    expect(routes).toContain('import("@/pages/youtube/YouTubeManagementPage")');
    expect(routes).toContain('path="/youtube"');
    const layout = readFileSync("src/components/layout/DashboardLayout.tsx", "utf8");
    expect(layout).toMatch(/flags\.youtubeManagement \? \[\{[^\]]*path: "\/youtube"/);
  });
});
