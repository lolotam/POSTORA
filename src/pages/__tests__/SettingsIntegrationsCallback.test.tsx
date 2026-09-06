import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, useLocation } from "react-router-dom";

// The composio-connect callback lands back on Settings → Integrations with
// `?connection=&result=`. The tab has to say what happened and then clear the
// params, so a refresh or a shared link does not re-announce a stale outcome.

const toast = vi.fn();
vi.mock("@/hooks/use-toast", () => ({ useToast: () => ({ toast }) }));

vi.mock("@/components/layout/DashboardLayout", () => ({
  DashboardLayout: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock("@/features/ai-providers", () => ({ AiProvidersPanel: () => null }));
vi.mock("@/components/automation/DatabaseConnectorsManager", () => ({
  DatabaseConnectorsManager: () => <div>connectors</div>,
}));
vi.mock("@/components/CookiePreferencesSection", () => ({ CookiePreferencesSection: () => null }));
vi.mock("@/components/settings", () => ({
  ProfileSection: () => null,
  SecuritySection: () => null,
  AppearanceSection: () => null,
  TimezoneSection: () => null,
  NotificationsSection: () => null,
  SubscriptionSection: () => null,
}));
vi.mock("@/hooks/useAuth", () => ({
  useAuth: () => ({ profile: { id: "u1", full_name: "W", email: "w@example.com" }, refreshProfile: vi.fn() }),
}));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { from: vi.fn() } }));

import Settings from "@/pages/Settings";

function Search() {
  return <span data-testid="search">{useLocation().search}</span>;
}

function renderAt(search: string) {
  return render(
    <MemoryRouter initialEntries={[`/settings${search}`]}>
      <Settings />
      <Search />
    </MemoryRouter>,
  );
}

describe("Settings → Integrations connection callback", () => {
  beforeEach(() => toast.mockReset());

  it("confirms a completed connection and clears the callback params", async () => {
    renderAt("?tab=integrations&connection=conn-1&result=ok");
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).not.toMatchObject({ variant: "destructive" });
    await waitFor(() => {
      const search = screen.getByTestId("search").textContent ?? "";
      expect(search).toContain("tab=integrations");
      expect(search).not.toContain("connection=");
      expect(search).not.toContain("result=");
    });
  });

  it("reports the refusal code when the authorisation did not complete", async () => {
    renderAt("?tab=integrations&connection=conn-1&result=invalid_state");
    await waitFor(() => expect(toast).toHaveBeenCalled());
    expect(toast.mock.calls[0][0]).toMatchObject({ variant: "destructive" });
    expect(String(toast.mock.calls[0][0].description)).toContain("invalid_state");
  });

  it("says nothing when the tab was opened without a callback", async () => {
    renderAt("?tab=integrations");
    await waitFor(() => expect(screen.getByText("connectors")).toBeInTheDocument());
    expect(toast).not.toHaveBeenCalled();
  });
});
