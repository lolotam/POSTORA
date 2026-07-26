import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { WorkspaceSwitcher } from "../WorkspaceSwitcher";
import { WhatsAppWorkspaceProvider, useWhatsAppWorkspaceContext } from "../WhatsAppWorkspaceProvider";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const personalWorkspace = { id: "personal", name: "Personal", owner_id: "user-1", is_personal: true, created_at: "2026-07-26T00:00:00.000Z", updated_at: "2026-07-26T00:00:00.000Z", role: "owner" as const };

function LoadingProbe() {
  const { isLoading } = useWhatsAppWorkspaceContext();
  return <span>{isLoading ? "Loading" : "Loaded"}</span>;
}

function renderSwitcher(workspaces: typeof personalWorkspace[]) {
  vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { workspaces }, error: null });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><WhatsAppWorkspaceProvider><LoadingProbe /><WorkspaceSwitcher /></WhatsAppWorkspaceProvider></QueryClientProvider>);
}

describe("WorkspaceSwitcher", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it("renders nothing for a single-workspace user", async () => {
    renderSwitcher([personalWorkspace]);
    await screen.findByText("Loaded");
    expect(screen.queryByRole("combobox", { name: "Active WhatsApp workspace" })).not.toBeInTheDocument();
  });

  it("renders a workspace selector for users with two workspaces", async () => {
    renderSwitcher([personalWorkspace, { ...personalWorkspace, id: "team", name: "Sales Team", is_personal: false }]);
    expect(await screen.findByRole("combobox", { name: "Active WhatsApp workspace" })).toBeInTheDocument();
  });
});
