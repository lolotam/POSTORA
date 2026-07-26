import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { authenticateCaller, type AuthResult } from "../_shared/auth-helper.ts";
import {
  createWorkspaceHandler,
  generateInvitationToken,
  InvitationAcceptanceError,
  type InvitationEmailMessage,
  type InvitationInsert,
  type WorkspaceClient,
  WorkspaceClientError,
  type WorkspaceInvitation,
  type WorkspaceMember,
  type WorkspaceRole,
  type WorkspaceSummary,
} from "./workspaceService.ts";

const FROM_EMAIL = "Postora <noreply@postora.cloud>";
const INVITATION_ACCEPT_URL =
  "https://postora.cloud/settings?workspace_invitation_token=";

interface DatabaseError {
  message: string;
  code?: string;
}

interface WorkspaceRow {
  id: string;
  name: string;
  owner_id: string;
  is_personal: boolean;
  created_at: string;
  updated_at: string;
}

interface MembershipRoleRow {
  workspace_id: string;
  role: WorkspaceRole;
}

function requiredEnvironment(name: string): string {
  const environmentValue = Deno.env.get(name);
  if (!environmentValue) throw new Error(`${name} is not configured`);
  return environmentValue;
}

function databaseFailure(error: DatabaseError): never {
  throw new WorkspaceClientError(error.message, error.code);
}

function workspaceRoleValue(role: unknown): WorkspaceRole | null {
  if (role === null) return null;
  if (
    role === "owner" || role === "admin" ||
    role === "agent" || role === "viewer"
  ) {
    return role;
  }
  throw new WorkspaceClientError("Database returned an invalid workspace role");
}

function callerSupabase(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Authorization is required");
  const supabaseKey = Deno.env.get("SUPABASE_ANON_KEY") ??
    requiredEnvironment("SUPABASE_PUBLISHABLE_KEY");
  return createClient(requiredEnvironment("SUPABASE_URL"), supabaseKey, {
    global: { headers: { Authorization: authorization } },
  });
}

function serviceSupabase() {
  return createClient(
    requiredEnvironment("SUPABASE_URL"),
    requiredEnvironment("SUPABASE_SERVICE_ROLE_KEY"),
  );
}

function invitationRow(row: unknown): WorkspaceInvitation {
  return row as WorkspaceInvitation;
}

function memberRow(row: unknown): WorkspaceMember {
  return row as WorkspaceMember;
}

function createSupabaseWorkspaceClient(req: Request): WorkspaceClient {
  const callerClient = callerSupabase(req);
  const adminClient = serviceSupabase();

  async function ensurePersonalWorkspace(userId: string): Promise<void> {
    const { error } = await callerClient.rpc("ensure_personal_workspace", {
      p_user_id: userId,
    });
    if (error) databaseFailure(error);
  }

  async function membershipSummary(
    membership: MembershipRoleRow,
  ): Promise<WorkspaceSummary> {
    const [workspaceQuery, memberCountQuery] = await Promise.all([
      callerClient.from("workspaces").select(
        "id, name, owner_id, is_personal, created_at, updated_at",
      ).eq("id", membership.workspace_id).single(),
      callerClient.from("workspace_members").select("id", {
        count: "exact",
        head: true,
      }).eq("workspace_id", membership.workspace_id),
    ]);
    if (workspaceQuery.error) databaseFailure(workspaceQuery.error);
    if (memberCountQuery.error) databaseFailure(memberCountQuery.error);
    const workspace = workspaceQuery.data as unknown as WorkspaceRow;
    return {
      ...workspace,
      role: membership.role,
      member_count: memberCountQuery.count ?? 0,
    };
  }

  async function listWorkspaces(userId: string): Promise<WorkspaceSummary[]> {
    const { data, error } = await callerClient.from("workspace_members")
      .select("workspace_id, role")
      .eq("user_id", userId)
      .order("created_at", { ascending: true });
    if (error) databaseFailure(error);
    const memberships = (data ?? []) as unknown as MembershipRoleRow[];
    return await Promise.all(memberships.map(membershipSummary));
  }

  async function workspaceRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null> {
    const { data, error } = await callerClient.rpc("workspace_role", {
      p_workspace_id: workspaceId,
      p_user_id: userId,
    });
    if (error) databaseFailure(error);
    return workspaceRoleValue(data);
  }

  async function workspaceName(workspaceId: string): Promise<string> {
    const { data, error } = await callerClient.from("workspaces")
      .select("name")
      .eq("id", workspaceId)
      .single();
    if (error) databaseFailure(error);
    const workspace = data as unknown as { name: string };
    return workspace.name;
  }

  async function listMembers(workspaceId: string): Promise<WorkspaceMember[]> {
    const { data, error } = await callerClient.from("workspace_members")
      .select("id, workspace_id, user_id, role, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .order("created_at", { ascending: true });
    if (error) databaseFailure(error);
    return (data ?? []).map(memberRow);
  }

  async function listPendingInvitations(
    workspaceId: string,
    nowIso: string,
  ): Promise<WorkspaceInvitation[]> {
    const { data, error } = await callerClient.from("workspace_invitations")
      .select(
        "id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at",
      )
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .gt("expires_at", nowIso)
      .order("created_at", { ascending: false });
    if (error) databaseFailure(error);
    return (data ?? []).map(invitationRow);
  }

  async function isEmailMember(
    workspaceId: string,
    email: string,
  ): Promise<boolean> {
    const profileQuery = await adminClient.from("profiles")
      .select("id")
      .ilike("email", email)
      .maybeSingle();
    if (profileQuery.error) databaseFailure(profileQuery.error);
    if (!profileQuery.data) return false;
    const profile = profileQuery.data as unknown as { id: string };
    const membershipQuery = await adminClient.from("workspace_members")
      .select("id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", profile.id)
      .maybeSingle();
    if (membershipQuery.error) databaseFailure(membershipQuery.error);
    return membershipQuery.data !== null;
  }

  async function createInvitation(
    invitation: InvitationInsert,
  ): Promise<WorkspaceInvitation> {
    const { data, error } = await callerClient.from("workspace_invitations")
      .insert({
        workspace_id: invitation.workspace_id,
        email: invitation.email,
        role: invitation.role,
        token_hash: invitation.token_hash,
        invited_by: invitation.invited_by,
        expires_at: invitation.expires_at,
      })
      .select(
        "id, workspace_id, email, role, invited_by, expires_at, accepted_at, accepted_by, revoked_at, created_at",
      )
      .single();
    if (error) databaseFailure(error);
    return invitationRow(data);
  }

  async function revokeInvitation(
    workspaceId: string,
    invitationId: string,
    revokedAt: string,
  ): Promise<boolean> {
    const { data, error } = await callerClient.from("workspace_invitations")
      .update({ revoked_at: revokedAt })
      .eq("id", invitationId)
      .eq("workspace_id", workspaceId)
      .is("accepted_at", null)
      .is("revoked_at", null)
      .select("id")
      .maybeSingle();
    if (error) databaseFailure(error);
    return data !== null;
  }

  async function acceptInvitation(rawToken: string): Promise<string> {
    const { data, error } = await callerClient.rpc(
      "accept_workspace_invitation",
      { p_token: rawToken },
    );
    if (error) throw new InvitationAcceptanceError(error.message);
    return data as string;
  }

  async function member(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceMember | null> {
    const { data, error } = await callerClient.from("workspace_members")
      .select("id, workspace_id, user_id, role, created_at, updated_at")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) databaseFailure(error);
    return data ? memberRow(data) : null;
  }

  async function countOwners(workspaceId: string): Promise<number> {
    const { count, error } = await callerClient.from("workspace_members")
      .select("id", { count: "exact", head: true })
      .eq("workspace_id", workspaceId)
      .eq("role", "owner");
    if (error) databaseFailure(error);
    return count ?? 0;
  }

  async function changeMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember> {
    const { data, error } = await callerClient.from("workspace_members")
      .update({ role })
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .select("id, workspace_id, user_id, role, created_at, updated_at")
      .maybeSingle();
    if (error) databaseFailure(error);
    if (!data) throw new WorkspaceClientError("Member not found");
    return memberRow(data);
  }

  async function removeMember(
    workspaceId: string,
    userId: string,
  ): Promise<void> {
    const { error } = await callerClient.from("workspace_members")
      .delete()
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId);
    if (error) databaseFailure(error);
  }

  return {
    ensurePersonalWorkspace,
    listWorkspaces,
    workspaceRole,
    workspaceName,
    listMembers,
    listPendingInvitations,
    isEmailMember,
    createInvitation,
    revokeInvitation,
    acceptInvitation,
    member,
    countOwners,
    changeMemberRole,
    removeMember,
  };
}

function escapeHtml(rawText: string): string {
  return rawText.replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function invitationEmailHtml(message: InvitationEmailMessage): string {
  const workspaceName = escapeHtml(message.workspaceName);
  const acceptanceUrl = `${INVITATION_ACCEPT_URL}${
    encodeURIComponent(message.rawToken)
  }`;
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Workspace invitation</title></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#1a1a2e;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f4f7;padding:32px 16px;"><tr><td align="center">
    <table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;">
      <tr><td style="background:#6366f1;padding:28px 24px;text-align:center;"><h1 style="margin:0;color:#fff;font-size:24px;">Join ${workspaceName}</h1></td></tr>
      <tr><td style="padding:32px 24px;text-align:center;">
        <p style="margin:0 0 24px;font-size:16px;line-height:1.6;">You have been invited to collaborate in the ${workspaceName} workspace on Postora.</p>
        <a href="${acceptanceUrl}" style="display:inline-block;background:#6366f1;color:#fff;text-decoration:none;font-weight:600;padding:12px 28px;border-radius:8px;">Accept invitation</a>
        <p style="margin:24px 0 0;font-size:12px;color:#6b7280;">This invitation expires in 7 days and can be used once.</p>
      </td></tr>
    </table>
  </td></tr></table>
</body>
</html>`;
}

async function sendInvitationEmail(
  message: InvitationEmailMessage,
): Promise<void> {
  const resendApiKey = requiredEnvironment("RESEND_API_KEY");
  const resendResponse = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: FROM_EMAIL,
      to: [message.to],
      subject: `You're invited to ${message.workspaceName} on Postora`,
      html: invitationEmailHtml(message),
    }),
  });
  if (!resendResponse.ok) {
    throw new Error(
      `Resend request failed with status ${resendResponse.status}`,
    );
  }
}

async function authenticate(req: Request): Promise<AuthResult> {
  return await authenticateCaller(req);
}

export const workspaceHandler = createWorkspaceHandler({
  authenticate,
  clientFor: createSupabaseWorkspaceClient,
  sendInvitationEmail,
  generateToken: generateInvitationToken,
  now: () => new Date(),
});

if (import.meta.main) Deno.serve(workspaceHandler);
