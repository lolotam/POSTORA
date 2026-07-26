import { useMutation, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { toast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import type { Tables } from "@/integrations/supabase/types";

export type WorkspaceRole = "owner" | "admin" | "agent" | "viewer";
export type InvitationRole = Exclude<WorkspaceRole, "owner">;

export interface WhatsAppWorkspace extends Tables<"workspaces"> {
  role: WorkspaceRole;
  member_count: number;
}

export type WorkspaceAgentProfile = Pick<
  Tables<"whatsapp_agents">,
  "display_name" | "status" | "current_conversations"
>;

type WorkspaceMembership = Omit<Tables<"workspace_members">, "role"> & {
  role: WorkspaceRole;
};

type WorkspaceMemberPayload = WorkspaceMembership & {
  email?: string | null;
  full_name?: string | null;
  avatar_url?: string | null;
  agent?: WorkspaceAgentProfile | null;
};

export type WorkspaceMember = WorkspaceMembership & {
  email: string | null;
  full_name: string | null;
  avatar_url: string | null;
  agent: WorkspaceAgentProfile | null;
};

export type WorkspaceInvitation = Omit<
  Tables<"workspace_invitations">,
  "role" | "token_hash" | "accepted_at" | "accepted_by" | "revoked_at"
> & {
  role: InvitationRole;
};

interface WorkspaceErrorPayload {
  error?: string | { message?: string };
}

interface WorkspaceListResponse extends WorkspaceErrorPayload {
  workspaces: WhatsAppWorkspace[];
}

interface MemberListResponse extends WorkspaceErrorPayload {
  members: WorkspaceMemberPayload[];
}

interface InvitationListResponse extends WorkspaceErrorPayload {
  invitations: WorkspaceInvitation[];
}

interface AcceptInvitationResponse extends WorkspaceErrorPayload {
  workspace_id: string;
}

interface MutationResponse extends WorkspaceErrorPayload {
  success?: boolean;
  invitation?: WorkspaceInvitation;
}

const workspaceRoleRank: Record<WorkspaceRole, number> = {
  viewer: 0,
  agent: 1,
  admin: 2,
  owner: 3,
};

export function roleAtLeast(role: WorkspaceRole | null | undefined, minimum: WorkspaceRole) {
  return role !== null && role !== undefined && workspaceRoleRank[role] >= workspaceRoleRank[minimum];
}

async function invokeWorkspace<T extends WorkspaceErrorPayload>(body: Record<string, unknown>) {
  const { data, error } = await supabase.functions.invoke<T>("whatsapp-workspace", { body });
  if (error) throw error;
  if (!data) throw new Error("The workspace service returned no data");
  if (data.error) {
    const message = typeof data.error === "string" ? data.error : data.error.message;
    throw new Error(message || "The workspace request failed");
  }
  return data;
}

async function workspaceAgentProfiles(workspaceId: string) {
  const { data, error } = await supabase
    .from("whatsapp_agents")
    .select("user_id, display_name, status, current_conversations")
    .eq("workspace_id", workspaceId);
  if (error) throw error;
  return data;
}

async function workspaceMembers(workspaceId: string) {
  const [memberResponse, agents] = await Promise.all([
    invokeWorkspace<MemberListResponse>({ action: "list_members", workspace_id: workspaceId }),
    workspaceAgentProfiles(workspaceId),
  ]);
  const agentsByUserId = new Map(agents.map((agent) => [agent.user_id, agent]));
  return memberResponse.members.map<WorkspaceMember>((member) => ({
    ...member,
    email: member.email ?? null,
    full_name: member.full_name ?? null,
    avatar_url: member.avatar_url ?? null,
    agent: agentsByUserId.get(member.user_id) ?? member.agent ?? null,
  }));
}

function invalidateTeamQueries(queryClient: QueryClient, workspaceId: string) {
  queryClient.invalidateQueries({ queryKey: ["whatsapp-workspace-members", workspaceId] });
  queryClient.invalidateQueries({ queryKey: ["whatsapp-workspace-invitations", workspaceId] });
}

export function useWorkspaces() {
  return useQuery({
    queryKey: ["whatsapp-workspaces"],
    queryFn: async () => {
      const response = await invokeWorkspace<WorkspaceListResponse>({ action: "list_workspaces" });
      return response.workspaces;
    },
  });
}

export function useWorkspaceMembers(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-workspace-members", workspaceId],
    queryFn: () => workspaceMembers(workspaceId!),
    enabled: Boolean(workspaceId),
  });
}

export function useWorkspaceInvitations(workspaceId: string | undefined) {
  return useQuery({
    queryKey: ["whatsapp-workspace-invitations", workspaceId],
    queryFn: async () => {
      const response = await invokeWorkspace<InvitationListResponse>({
        action: "list_invitations",
        workspace_id: workspaceId,
      });
      return response.invitations;
    },
    enabled: Boolean(workspaceId),
  });
}

export function useInviteMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, email, role }: { workspaceId: string; email: string; role: InvitationRole }) =>
      invokeWorkspace<MutationResponse>({ action: "invite_member", workspace_id: workspaceId, email, role }),
    onSuccess: (_response, variables) => {
      invalidateTeamQueries(queryClient, variables.workspaceId);
      toast({ title: "Invitation sent", description: `An invitation was sent to ${variables.email}.` });
    },
    onError: () => {
      toast({ title: "Invitation failed", description: "The invitation could not be sent.", variant: "destructive" });
    },
  });
}

export function useRevokeInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, invitationId }: { workspaceId: string; invitationId: string }) =>
      invokeWorkspace<MutationResponse>({ action: "revoke_invitation", workspace_id: workspaceId, invitation_id: invitationId }),
    onSuccess: (_response, variables) => {
      invalidateTeamQueries(queryClient, variables.workspaceId);
      toast({ title: "Invitation revoked" });
    },
    onError: () => {
      toast({ title: "Revoke failed", description: "The invitation could not be revoked.", variant: "destructive" });
    },
  });
}

export function useChangeMemberRole() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, userId, role }: { workspaceId: string; userId: string; role: WorkspaceRole }) =>
      invokeWorkspace<MutationResponse>({ action: "change_member_role", workspace_id: workspaceId, user_id: userId, role }),
    onSuccess: (_response, variables) => {
      invalidateTeamQueries(queryClient, variables.workspaceId);
      toast({ title: "Member role updated" });
    },
    onError: () => {
      toast({ title: "Role update failed", description: "The member role could not be changed.", variant: "destructive" });
    },
  });
}

export function useRemoveMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ workspaceId, userId }: { workspaceId: string; userId: string }) =>
      invokeWorkspace<MutationResponse>({ action: "remove_member", workspace_id: workspaceId, user_id: userId }),
    onSuccess: (_response, variables) => {
      invalidateTeamQueries(queryClient, variables.workspaceId);
      toast({ title: "Member removed" });
    },
    onError: () => {
      toast({ title: "Removal failed", description: "The member could not be removed.", variant: "destructive" });
    },
  });
}

export function useAcceptInvitation() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (token: string) => {
      const response = await invokeWorkspace<AcceptInvitationResponse>({ action: "accept_invitation", token });
      return response.workspace_id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-workspaces"] });
    },
  });
}
