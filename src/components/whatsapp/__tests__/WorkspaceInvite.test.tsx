import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import WorkspaceInvite from "@/pages/WorkspaceInvite";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import { WHATSAPP_WORKSPACE_STORAGE_KEY } from "../WhatsAppWorkspaceProvider";

vi.mock("@/hooks/useAuth", () => ({ useAuth: vi.fn() }));
vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));

function renderInvite(initialEntry = "/workspace/invite?token=raw-token") {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><MemoryRouter initialEntries={[initialEntry]}><Routes>
    <Route path="/workspace/invite" element={<WorkspaceInvite />} />
    <Route path="/messaging/whatsapp" element={<div>WhatsApp workspace</div>} />
    <Route path="/auth" element={<div>Authentication</div>} />
  </Routes></MemoryRouter></QueryClientProvider>);
}

describe("WorkspaceInvite", () => {
  beforeEach(() => { localStorage.clear(); sessionStorage.clear(); vi.clearAllMocks(); });

  it("accepts an invitation and routes into the joined WhatsApp workspace", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: "user-1" }, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { workspace_id: "workspace-2" }, error: null });
    renderInvite();
    await waitFor(() => expect(screen.getByText("WhatsApp workspace")).toBeInTheDocument());
    expect(localStorage.getItem(WHATSAPP_WORKSPACE_STORAGE_KEY)).toBe("workspace-2");
  });

  it("shows one generic failure state without exposing the backend reason", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: { id: "user-1" }, isLoading: false } as ReturnType<typeof useAuth>);
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: null, error: new Error("Invitation expired for owner@example.com") });
    renderInvite();
    expect(await screen.findByText("This invitation is invalid or no longer available.")).toBeInTheDocument();
    expect(screen.queryByText(/expired/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/owner@example\.com/i)).not.toBeInTheDocument();
  });

  it("sends signed-out visitors to auth while preserving the invitation URL", async () => {
    vi.mocked(useAuth).mockReturnValue({ user: null, isLoading: false } as ReturnType<typeof useAuth>);
    renderInvite();
    await waitFor(() => expect(screen.getByText("Authentication")).toBeInTheDocument());
    expect(sessionStorage.getItem("oauth_redirect_after_login")).toBe("/workspace/invite?token=raw-token");
  });
});
