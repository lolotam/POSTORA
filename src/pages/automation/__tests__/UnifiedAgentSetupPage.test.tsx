import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import UnifiedAgentSetupPage from "../UnifiedAgentSetupPage";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

const managerProps = vi.fn();
vi.mock("@/components/messaging/AiAgentManager", () => ({
  AI_AGENT_TABS: ["settings", "knowledge", "tools", "test", "logs"] as const,
  AiAgentManager: (props: { platform: string; surface: string }) => {
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
