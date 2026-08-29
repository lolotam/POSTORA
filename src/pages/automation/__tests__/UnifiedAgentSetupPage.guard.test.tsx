import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { MemoryRouter, useSearchParams } from "react-router-dom";
import UnifiedAgentSetupPage from "../UnifiedAgentSetupPage";

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock("@/components/messaging/AiAgentManager", async () => {
  const { useEffect, useState } = await import("react");
  return {
    AI_AGENT_TABS: ["settings", "knowledge", "tools", "test", "logs"] as const,
    AiAgentManager: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => {
      const [dirty, setDirty] = useState(false);
      useEffect(() => {
        onDirtyChange?.(dirty);
      }, [dirty, onDirtyChange]);
      return <button onClick={() => setDirty(true)}>make dirty</button>;
    },
  };
});

vi.mock("@/hooks/useFeatureFlags", () => ({
  useFeatureFlags: () => ({
    flags: {
      msgWhatsapp: true,
      msgFacebook: true,
      msgInstagram: true,
      msgThreads: true,
    },
    isLoading: false,
  }),
}));

vi.mock("@/hooks/useSocialAccounts", () => ({
  useSocialAccounts: () => ({ data: [] }),
}));

vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

function SearchProbe() {
  const [params] = useSearchParams();
  return <span data-testid="platform-param">{params.get("platform")}</span>;
}

function renderPage() {
  return render(
    <MemoryRouter initialEntries={["/automation?platform=instagram"]}>
      <UnifiedAgentSetupPage />
      <SearchProbe />
    </MemoryRouter>,
  );
}

describe("UnifiedAgentSetupPage unsaved guard", () => {
  it("prompts before a platform switch discards edits", async () => {
    renderPage();

    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /threads/i }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });

  it("Keep editing leaves the platform unchanged", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /threads/i }));
    fireEvent.click(await screen.findByRole("button", { name: /keep editing/i }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("platform-param")).toHaveTextContent("instagram");
  });

  it("Discard changes lets the platform switch through", async () => {
    // The cancel path alone proves the dialog can block. This proves the dialog can
    // also get out of the way -- a guard that never releases the transition would
    // pass every other test in this file.
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /threads/i }));
    fireEvent.click(await screen.findByRole("button", { name: /discard changes/i }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("platform-param")).toHaveTextContent("threads");
  });

  it("clicking the already-active platform never reaches the guard", async () => {
    // Regression guard (Codex review, PR #69). A no-op click used to open the dialog;
    // discarding it cleared the parent's flag while the child never remounted and so
    // never re-reported, leaving the guard disarmed for the next real switch.
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("tab", { name: /instagram/i }));

    expect(screen.queryByText(/you have unsaved changes/i)).not.toBeInTheDocument();

    // and the guard is still armed for a transition that does remount the child
    fireEvent.click(await screen.findByRole("tab", { name: /threads/i }));
    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
    expect(screen.getByTestId("platform-param")).toHaveTextContent("instagram");
  });

  it("prompts before a surface toggle discards edits", async () => {
    renderPage();
    fireEvent.click(await screen.findByRole("button", { name: /make dirty/i }));
    fireEvent.click(await screen.findByRole("button", { name: /comments/i }));

    expect(await screen.findByText(/you have unsaved changes/i)).toBeInTheDocument();
  });
});
