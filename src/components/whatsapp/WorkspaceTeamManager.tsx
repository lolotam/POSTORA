import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import type { TFunction } from "i18next";
import { format } from "date-fns";
import { Loader2, MailPlus, UserMinus, Users } from "lucide-react";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  roleAtLeast, useChangeMemberRole, useInviteMember, useRemoveMember,
  useRevokeInvitation, useWorkspaceInvitations, useWorkspaceMembers,
  type InvitationRole, type WorkspaceInvitation, type WorkspaceMember, type WorkspaceRole,
} from "@/hooks/useWhatsAppWorkspace";
import { useWhatsAppWorkspaceContext } from "./WhatsAppWorkspaceProvider";

const WORKSPACE_ROLES = ["owner", "admin", "agent", "viewer"] as const satisfies readonly WorkspaceRole[];
const INVITATION_ROLES = ["admin", "agent", "viewer"] as const satisfies readonly InvitationRole[];
const inviteSchema = z.object({ email: z.string().trim().email() });

function isWorkspaceRole(role: string): role is WorkspaceRole {
  return WORKSPACE_ROLES.some((candidate) => candidate === role);
}

function isInvitationRole(role: string): role is InvitationRole {
  return INVITATION_ROLES.some((candidate) => candidate === role);
}

function roleLabel(role: WorkspaceRole, t: TFunction) {
  switch (role) {
    case "owner": return t("team.roles.owner", "Owner");
    case "admin": return t("team.roles.admin", "Admin");
    case "agent": return t("team.roles.agent", "Agent");
    case "viewer": return t("team.roles.viewer", "Viewer");
    default: return role;
  }
}

function memberName(member: WorkspaceMember, t: TFunction) {
  return member.full_name || member.agent?.display_name || member.email || t("team.memberFallback", "Workspace member");
}

function AgentPresence({ member }: { member: WorkspaceMember }) {
  const { t } = useTranslation("whatsapp");
  if (!member.agent) return null;
  const conversations = member.agent.current_conversations ?? 0;
  return (
    <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
      <Badge variant="outline">{member.agent.display_name}</Badge>
      <span className="capitalize">{member.agent.status}</span>
      <span>{t("team.activeConversations", "{{count}} active conversations", { count: conversations })}</span>
    </div>
  );
}

interface MemberActionsProps {
  member: WorkspaceMember;
  workspaceId: string;
  isLastOwner: boolean;
}

function MemberActions({ member, workspaceId, isLastOwner }: MemberActionsProps) {
  const { t } = useTranslation("whatsapp");
  const changeRole = useChangeMemberRole();
  const removeMember = useRemoveMember();
  const name = memberName(member, t);

  if (isLastOwner) return <span className="text-xs text-muted-foreground">{t("team.lastOwner", "Last owner")}</span>;

  const updateRole = (role: string) => {
    if (!isWorkspaceRole(role)) return;
    changeRole.mutate({ workspaceId, userId: member.user_id, role });
  };

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      <Select value={member.role} onValueChange={updateRole} disabled={changeRole.isPending}>
        <SelectTrigger className="w-[130px]" aria-label={t("team.changeRoleAria", "Change role for {{name}}", { name })}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {WORKSPACE_ROLES.map((role) => <SelectItem key={role} value={role}>{roleLabel(role, t)}</SelectItem>)}
        </SelectContent>
      </Select>
      <AlertDialog>
        <AlertDialogTrigger asChild>
          <Button variant="outline" size="sm" aria-label={t("team.removeAria", "Remove {{name}}", { name })}>
            <UserMinus className="me-2 h-4 w-4" />{t("team.remove", "Remove")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("team.removeConfirm", "Remove {{name}}?", { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t("team.removeDesc", "This person will lose access to this WhatsApp workspace.")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => removeMember.mutate({ workspaceId, userId: member.user_id })}>
              {t("team.removeMember", "Remove member")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function MembersList({ members, workspaceId, canManage }: { members: WorkspaceMember[]; workspaceId: string; canManage: boolean }) {
  const { t } = useTranslation("whatsapp");
  const ownerCount = members.filter((member) => member.role === "owner").length;
  return (
    <div className="divide-y rounded-lg border">
      {members.map((member) => {
        const isLastOwner = member.role === "owner" && ownerCount === 1;
        return (
          <div key={member.id} className="flex flex-col gap-4 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="font-medium">{memberName(member, t)}</p>
                <Badge variant="secondary">{roleLabel(member.role, t)}</Badge>
              </div>
              <p className="truncate text-sm text-muted-foreground">{member.email ?? t("team.emailUnavailable", "Email unavailable")}</p>
              <p className="mt-1 text-xs text-muted-foreground">{t("team.joined", "Joined {{date}}", { date: format(new Date(member.created_at), "PP") })}</p>
              <AgentPresence member={member} />
            </div>
            {canManage && <MemberActions member={member} workspaceId={workspaceId} isLastOwner={isLastOwner} />}
          </div>
        );
      })}
    </div>
  );
}

function InviteMemberForm({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation("whatsapp");
  const inviteMember = useInviteMember();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<InvitationRole>("agent");
  const [validationError, setValidationError] = useState<string>();

  const submitInvitation = (event: FormEvent) => {
    event.preventDefault();
    const parsed = inviteSchema.safeParse({ email });
    if (!parsed.success) {
      setValidationError(t("errors.validEmail", "Enter a valid email address"));
      return;
    }
    setValidationError(undefined);
    inviteMember.mutate({ workspaceId, email: parsed.data.email, role }, {
      onSuccess: () => setEmail(""),
    });
  };

  const selectRole = (nextRole: string) => {
    if (isInvitationRole(nextRole)) setRole(nextRole);
  };

  return (
    <form onSubmit={submitInvitation} className="grid gap-4 rounded-lg border p-4 sm:grid-cols-[1fr_160px_auto] sm:items-end">
      <div className="space-y-2">
        <Label htmlFor="workspace-invite-email">{t("team.email", "Email address")}</Label>
        <Input id="workspace-invite-email" type="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder={t("team.inviteEmailPlaceholder", "teammate@example.com")} aria-invalid={Boolean(validationError)} />
        {validationError && <p className="text-sm text-destructive">{validationError}</p>}
      </div>
      <div className="space-y-2">
        <Label>{t("team.role", "Role")}</Label>
        <Select value={role} onValueChange={selectRole}>
          <SelectTrigger aria-label={t("team.inviteRoleAria", "Invitation role")}><SelectValue /></SelectTrigger>
          <SelectContent>
            {INVITATION_ROLES.map((option) => <SelectItem key={option} value={option}>{roleLabel(option, t)}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <Button type="submit" disabled={inviteMember.isPending}>
        {inviteMember.isPending ? <Loader2 className="me-2 h-4 w-4 animate-spin" /> : <MailPlus className="me-2 h-4 w-4" />}
        {t("team.invite", "Invite member")}
      </Button>
    </form>
  );
}

function PendingInvitations({ invitations, workspaceId }: { invitations: WorkspaceInvitation[]; workspaceId: string }) {
  const { t } = useTranslation("whatsapp");
  const revokeInvitation = useRevokeInvitation();
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-lg">{t("team.pendingInvites", "Pending invitations")}</CardTitle>
        <CardDescription>{t("team.pendingInvitesDesc", "Invitations that have not been accepted or revoked.")}</CardDescription>
      </CardHeader>
      <CardContent>
        {invitations.length === 0 ? <p className="text-sm text-muted-foreground">{t("team.noInvites", "No pending invitations.")}</p> : (
          <div className="divide-y rounded-lg border">
            {invitations.map((invitation) => (
              <div key={invitation.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                <div>
                  <p className="font-medium">{invitation.email}</p>
                  <p className="text-sm text-muted-foreground">{t("team.expires", "{{role}} · Expires {{date}}", { role: roleLabel(invitation.role, t), date: format(new Date(invitation.expires_at), "PP") })}</p>
                </div>
                <Button variant="outline" size="sm" disabled={revokeInvitation.isPending} aria-label={t("team.revokeAria", "Revoke invitation for {{email}}", { email: invitation.email })} onClick={() => revokeInvitation.mutate({ workspaceId, invitationId: invitation.id })}>
                  {t("team.revoke", "Revoke")}
                </Button>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

export function WorkspaceTeamManager() {
  const { t } = useTranslation("whatsapp");
  const { activeWorkspaceId, activeRole } = useWhatsAppWorkspaceContext();
  const canManage = roleAtLeast(activeRole, "admin");
  const membersQuery = useWorkspaceMembers(activeWorkspaceId);
  const invitationsQuery = useWorkspaceInvitations(canManage ? activeWorkspaceId : undefined);

  if (!activeWorkspaceId) return <Alert><Users className="h-4 w-4" /><AlertTitle>{t("team.noWorkspace", "No workspace selected")}</AlertTitle><AlertDescription>{t("team.noWorkspaceDesc", "Select a workspace to manage its team.")}</AlertDescription></Alert>;
  if (membersQuery.isLoading) return <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" />{t("team.loadingTeam", "Loading team…")}</div>;
  if (membersQuery.error) return <Alert variant="destructive"><AlertTitle>{t("errors.teamUnavailable", "Team unavailable")}</AlertTitle><AlertDescription>{t("errors.teamLoad", "The workspace team could not be loaded.")}</AlertDescription></Alert>;

  const members = membersQuery.data ?? [];
  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>{t("team.members", "Workspace members")}</CardTitle>
          <CardDescription>{t("team.membersDesc", "People with access to this WhatsApp workspace and their operational presence.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {canManage && <InviteMemberForm workspaceId={activeWorkspaceId} />}
          {members.length === 0 ? <p className="text-sm text-muted-foreground">{t("team.noMembers", "No workspace members found.")}</p> : <MembersList members={members} workspaceId={activeWorkspaceId} canManage={canManage} />}
        </CardContent>
      </Card>
      {canManage && invitationsQuery.isLoading && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />{t("team.loadingInvites", "Loading invitations…")}
        </div>
      )}
      {canManage && invitationsQuery.error && (
        <Alert variant="destructive">
          <AlertTitle>{t("team.invitationsUnavailable", "Invitations unavailable")}</AlertTitle>
          <AlertDescription>{t("team.invitationsUnavailableDesc", "Pending invitations could not be loaded.")}</AlertDescription>
        </Alert>
      )}
      {canManage && !invitationsQuery.isLoading && !invitationsQuery.error && (
        <PendingInvitations invitations={invitationsQuery.data ?? []} workspaceId={activeWorkspaceId} />
      )}
    </div>
  );
}
