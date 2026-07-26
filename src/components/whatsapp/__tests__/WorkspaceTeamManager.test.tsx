import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import type { WorkspaceMember, WorkspaceRole } from "@/hooks/useWhatsAppWorkspace";
import { WhatsAppWorkspaceProvider } from "../WhatsAppWorkspaceProvider";
import { WorkspaceTeamManager } from "../WorkspaceTeamManager";

vi.mock("@/integrations/supabase/client", () => ({
  supabase: {
    functions: { invoke: vi.fn() },
    from: vi.fn(() => ({
      select: vi.fn(() => ({
        eq: vi.fn().mockResolvedValue({
          data: [
            { user_id: "user-owner", display_name: "Lead Agent", status: "online", current_conversations: 3 },
            { user_id: "user-agent", display_name: "Sales Agent", status: "offline", current_conversations: 0 },
          ],
          error: null,
        }),
      })),
    })),
  },
}));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

const owner: WorkspaceMember = {
  id: "member-owner", workspace_id: "workspace-1", user_id: "user-owner", role: "owner",
  created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z",
  email: "owner@example.com", full_name: "Workspace Owner", avatar_url: null,
  agent: { display_name: "Lead Agent", status: "online", current_conversations: 3 },
};
const agent: WorkspaceMember = { ...owner, id: "member-agent", user_id: "user-agent", role: "agent", email: "agent@example.com", full_name: "Sales Agent", agent: null };

function mockWorkspaceApi(role: WorkspaceRole, members: WorkspaceMember[] = [owner, agent]) {
  vi.mocked(supabase.functions.invoke).mockImplementation(async (_functionName, options) => {
    const request = options?.body as { action?: string };
    if (request.action === "list_workspaces") {
      return { data: { workspaces: [{ id: "workspace-1", name: "Team", owner_id: "user-owner", is_personal: true, created_at: "2026-07-01T00:00:00.000Z", updated_at: "2026-07-01T00:00:00.000Z", role }] }, error: null };
    }
    if (request.action === "list_members") return { data: { members }, error: null };
    if (request.action === "list_invitations") {
      return { data: { invitations: [{ id: "invite-1", workspace_id: "workspace-1", email: "pending@example.com", role: "viewer", created_at: "2026-07-20T00:00:00.000Z", expires_at: "2026-08-20T00:00:00.000Z", invited_by: "user-owner" }] }, error: null };
    }
    return { data: { success: true }, error: null };
  });
}

function renderTeam() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><WhatsAppWorkspaceProvider><WorkspaceTeamManager /></WhatsAppWorkspaceProvider></QueryClientProvider>);
}

describe("WorkspaceTeamManager permissions", () => {
  beforeEach(() => { localStorage.clear(); vi.clearAllMocks(); });

  it.each(["viewer", "agent"] as const)("%s sees operational profiles but no team mutation controls", async (role) => {
    mockWorkspaceApi(role);
    renderTeam();
    expect(await screen.findByText("Lead Agent")).toBeInTheDocument();
    expect(screen.getByText(/3 active conversations/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /invite member/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /revoke/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove/i })).not.toBeInTheDocument();
  });

  it.each(["owner", "admin"] as const)("%s sees invite, revoke, role, and remove controls", async (role) => {
    mockWorkspaceApi(role);
    renderTeam();
    expect(await screen.findByRole("button", { name: /invite member/i })).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: /revoke invitation/i })).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: /change role for sales agent/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove sales agent/i })).toBeInTheDocument();
  });

  it("does not offer demote or remove controls for the last owner", async () => {
    mockWorkspaceApi("owner", [owner, agent]);
    renderTeam();
    await screen.findByText("Workspace Owner");
    expect(screen.queryByRole("combobox", { name: /change role for workspace owner/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /remove workspace owner/i })).not.toBeInTheDocument();
  });
});
