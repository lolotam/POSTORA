import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { WhatsAppWorkspaceProvider, WHATSAPP_WORKSPACE_STORAGE_KEY, useWhatsAppWorkspaceContext } from "../WhatsAppWorkspaceProvider";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

const workspaces = [
  { id: "personal", name: "Personal", owner_id: "user-1", is_personal: true, created_at: "2026-07-26T00:00:00.000Z", updated_at: "2026-07-26T00:00:00.000Z", role: "owner" as const },
  { id: "team", name: "Sales Team", owner_id: "user-2", is_personal: false, created_at: "2026-07-26T00:00:00.000Z", updated_at: "2026-07-26T00:00:00.000Z", role: "agent" as const },
];

function Probe() {
  const context = useWhatsAppWorkspaceContext();
  return <div><span data-testid="active-id">{context.activeWorkspaceId}</span><span data-testid="active-role">{context.activeRole}</span></div>;
}
function SelectionProbe() {
  const context = useWhatsAppWorkspaceContext();
  return <div><span data-testid="selected-id">{context.activeWorkspaceId}</span><button onClick={() => context.setActiveWorkspaceId("team")}>Select team</button></div>;
}

function renderProvider(children: ReactNode = <Probe />) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><WhatsAppWorkspaceProvider>{children}</WhatsAppWorkspaceProvider></QueryClientProvider>);
}

describe("WhatsAppWorkspaceProvider", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { workspaces }, error: null });
  });

  it("restores an accessible persisted workspace selection", async () => {
    localStorage.setItem(WHATSAPP_WORKSPACE_STORAGE_KEY, "team");
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-role")).toHaveTextContent("agent"));
    expect(screen.getByTestId("active-id")).toHaveTextContent("team");
  });

  it("updates and persists an accessible workspace selection", async () => {
    renderProvider(<SelectionProbe />);
    await waitFor(() => expect(screen.getByTestId("selected-id")).toHaveTextContent("personal"));
    fireEvent.click(screen.getByRole("button", { name: "Select team" }));
    await waitFor(() => expect(screen.getByTestId("selected-id")).toHaveTextContent("team"));
    expect(localStorage.getItem(WHATSAPP_WORKSPACE_STORAGE_KEY)).toBe("team");
  });

  it("falls back to the personal workspace when the persisted id is inaccessible", async () => {
    localStorage.setItem(WHATSAPP_WORKSPACE_STORAGE_KEY, "removed-workspace");
    renderProvider();
    await waitFor(() => expect(screen.getByTestId("active-id")).toHaveTextContent("personal"));
    expect(localStorage.getItem(WHATSAPP_WORKSPACE_STORAGE_KEY)).toBe("personal");
  });

});
