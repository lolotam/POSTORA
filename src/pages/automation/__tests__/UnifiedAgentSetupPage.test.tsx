import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import UnifiedAgentSetupPage from "../UnifiedAgentSetupPage";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const managerProps = vi.fn();
vi.mock("@/components/messaging/AiAgentManager", async (importOriginal) => ({
  // The real list: a hand-copied one hid that "dashboard" was missing from it.
  AI_AGENT_TABS: (await importOriginal<typeof import("@/components/messaging/AiAgentManager")>()).AI_AGENT_TABS,
  AiAgentManager: (props: { platform: string; surface: string; activeTab?: string }) => {
    managerProps(props);
    return <div data-testid="agent-manager" />;
  },
}));

const flags = vi.hoisted(() => ({
  msgWhatsapp: true,
  msgFacebook: true,
  msgInstagram: true,
  msgThreads: true,
  youtubeComments: true,
}));
vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({ flags, isLoading: false }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({
    data: [
      { id: "yt-1", platform: "youtube", platform_username: "My Channel", platform_user_id: "UC1", is_active: true, auth_provider: "composio", account_metadata: {} },
    ],
  }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/automation${search}`]}>
      <Routes>
        <Route path="/automation" element={<UnifiedAgentSetupPage />} />
        <Route path="/dashboard" element={<span data-testid="dashboard" />} />
      </Routes>
    </MemoryRouter>,
  );
}

describe("UnifiedAgentSetupPage for YouTube", () => {
  it("offers YouTube as a comments-only surface: no DM toggle, comments handed to the agent", () => {
    // YouTube has no private messages, so the DM toggle would configure nothing. The page owns
    // this exception rather than resolveAgentSurface, which models "no comments" (WhatsApp).
    renderAt("?platform=youtube&surface=both");

    expect(screen.getByRole("tab", { name: /youtube/i })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /direct messaging/i })).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /comments/i })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: /comments agent configuration/i })).toBeInTheDocument();
    expect(managerProps).toHaveBeenLastCalledWith(expect.objectContaining({ platform: "youtube", surface: "comments" }));
  });

  it("is gated by feature_youtube_comments", () => {
    flags.youtubeComments = false;
    renderAt("?platform=youtube");
    expect(screen.getByTestId("dashboard")).toBeInTheDocument();
    flags.youtubeComments = true;
  });
});

describe("UnifiedAgentSetupPage tab from the URL", () => {
  it.each(["settings", "knowledge", "tools", "test", "dashboard", "logs"])("opens ?tab=%s on that tab", (tab) => {
    renderAt(`?platform=youtube&tab=${tab}`);
    expect(managerProps).toHaveBeenLastCalledWith(expect.objectContaining({ activeTab: tab }));
  });

  it("falls back to settings for an unknown tab", () => {
    renderAt("?platform=youtube&tab=nope");
    expect(managerProps).toHaveBeenLastCalledWith(expect.objectContaining({ activeTab: "settings" }));
  });
});
