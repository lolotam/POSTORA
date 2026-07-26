import type { ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { supabase } from "@/integrations/supabase/client";
import { roleAtLeast, useAcceptInvitation, useChangeMemberRole, useInviteMember, useWorkspaces } from "../useWhatsAppWorkspace";

vi.mock("@/integrations/supabase/client", () => ({ supabase: { functions: { invoke: vi.fn() } } }));
vi.mock("@/hooks/use-toast", () => ({ toast: vi.fn() }));

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>;
  };
}

describe("WhatsApp workspace hooks", () => {
  beforeEach(() => vi.clearAllMocks());

  it("loads workspaces with the caller role from the workspace function", async () => {
    const workspaces = [{
      id: "personal", name: "Personal", owner_id: "user-1", is_personal: true,
      created_at: "2026-07-26T00:00:00.000Z", updated_at: "2026-07-26T00:00:00.000Z", role: "owner",
    }];
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { workspaces }, error: null });
    const { result } = renderHook(() => useWorkspaces(), { wrapper: createWrapper() });
    await waitFor(() => expect(result.current.isSuccess).toBe(true));
    expect(result.current.data).toEqual(workspaces);
    expect(supabase.functions.invoke).toHaveBeenCalledWith("whatsapp-workspace", {
      body: { action: "list_workspaces" },
    });
  });

  it("sends the typed invitation request through the workspace function", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { invitation_id: "invite-1" }, error: null });
    const { result } = renderHook(() => useInviteMember(), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.mutateAsync({ workspaceId: "workspace-1", email: "agent@example.com", role: "agent" });
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("whatsapp-workspace", {
      body: { action: "invite_member", workspace_id: "workspace-1", email: "agent@example.com", role: "agent" },
    });
  });

  it("targets role changes by the backend user_id contract", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { success: true }, error: null });
    const { result } = renderHook(() => useChangeMemberRole(), { wrapper: createWrapper() });
    await act(async () => {
      await result.current.mutateAsync({ workspaceId: "workspace-1", userId: "user-2", role: "admin" });
    });
    expect(supabase.functions.invoke).toHaveBeenCalledWith("whatsapp-workspace", {
      body: { action: "change_member_role", workspace_id: "workspace-1", user_id: "user-2", role: "admin" },
    });
  });

  it("returns the joined workspace id after accepting a raw invitation token", async () => {
    vi.mocked(supabase.functions.invoke).mockResolvedValue({ data: { workspace_id: "workspace-2" }, error: null });
    const { result } = renderHook(() => useAcceptInvitation(), { wrapper: createWrapper() });
    let workspaceId = "";
    await act(async () => { workspaceId = await result.current.mutateAsync("raw-invitation-token"); });
    expect(workspaceId).toBe("workspace-2");
    expect(supabase.functions.invoke).toHaveBeenCalledWith("whatsapp-workspace", {
      body: { action: "accept_invitation", token: "raw-invitation-token" },
    });
  });
});

describe("roleAtLeast", () => {
  it.each([
    ["owner", "admin", true], ["admin", "admin", true],
    ["agent", "admin", false], ["viewer", "agent", false],
  ] as const)("%s at least %s is %s", (role, minimum, expected) => {
    expect(roleAtLeast(role, minimum)).toBe(expected);
  });
});
