import { handleCorsOptions, jsonResponse } from "../_shared/cors.ts";
import {
  roleAtLeast,
  WORKSPACE_ROLE_RANK,
  type WorkspaceRole,
} from "../_shared/whatsappWorkspaceAccess.ts";

export { roleAtLeast, WORKSPACE_ROLE_RANK };
export type { WorkspaceRole };

const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const WORKSPACE_NOT_FOUND = "Workspace not found";
const LAST_OWNER_ERROR = "A workspace must retain at least one owner";

export type InvitationRole = Exclude<WorkspaceRole, "owner">;

export interface AuthenticatedCaller {
  userId: string;
  isServiceRole: boolean;
}

export interface WorkspaceSummary {
  id: string;
  name: string;
  owner_id: string;
  is_personal: boolean;
  created_at: string;
  updated_at: string;
  role: WorkspaceRole;
  member_count: number;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  user_id: string;
  role: WorkspaceRole;
  created_at: string;
  updated_at: string;
}

export interface InvitationInsert {
  workspace_id: string;
  email: string;
  role: InvitationRole;
  token_hash: string;
  invited_by: string;
  expires_at: string;
}

export interface WorkspaceInvitation {
  id: string;
  workspace_id: string;
  email: string;
  role: InvitationRole;
  invited_by: string;
  expires_at: string;
  accepted_at: string | null;
  accepted_by: string | null;
  revoked_at: string | null;
  created_at: string;
}

export interface WorkspaceClient {
  ensurePersonalWorkspace(userId: string): Promise<void>;
  listWorkspaces(userId: string): Promise<WorkspaceSummary[]>;
  workspaceRole(
    workspaceId: string,
    userId: string,
  ): Promise<WorkspaceRole | null>;
  workspaceName(workspaceId: string): Promise<string>;
  listMembers(workspaceId: string): Promise<WorkspaceMember[]>;
  listPendingInvitations(
    workspaceId: string,
    nowIso: string,
  ): Promise<WorkspaceInvitation[]>;
  isEmailMember(workspaceId: string, email: string): Promise<boolean>;
  createInvitation(invitation: InvitationInsert): Promise<WorkspaceInvitation>;
  revokeInvitation(
    workspaceId: string,
    invitationId: string,
    revokedAt: string,
  ): Promise<boolean>;
  acceptInvitation(rawToken: string): Promise<string>;
  member(workspaceId: string, userId: string): Promise<WorkspaceMember | null>;
  countOwners(workspaceId: string): Promise<number>;
  changeMemberRole(
    workspaceId: string,
    userId: string,
    role: WorkspaceRole,
  ): Promise<WorkspaceMember>;
  removeMember(workspaceId: string, userId: string): Promise<void>;
}

export interface InvitationEmailMessage {
  to: string;
  workspaceName: string;
  rawToken: string;
}

export interface WorkspaceHandlerDependencies {
  authenticate(req: Request): Promise<AuthenticatedCaller>;
  clientFor(req: Request): WorkspaceClient;
  sendInvitationEmail(message: InvitationEmailMessage): Promise<void>;
  generateToken(): string;
  now(): Date;
}

export class InvitationAcceptanceError extends Error {}

export class WorkspaceClientError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function canReadWorkspace(
  role: WorkspaceRole | null,
): role is WorkspaceRole {
  return role !== null;
}

export function canManageWorkspace(role: WorkspaceRole | null): boolean {
  return role !== null && roleAtLeast(role, "admin");
}

/**
 * Granting or revoking ownership is reserved to owners.
 *
 * Admins may manage agents and viewers, but must not be able to mint owners —
 * otherwise an admin could promote itself to owner, and then, because the
 * workspace now has two owners, the last-owner guard would no longer block it
 * from removing the original owner. That chain is a full workspace takeover from
 * an admin seat, so ownership changes are gated separately from ordinary
 * management.
 */
export function canChangeOwnership(role: WorkspaceRole | null): boolean {
  return role === "owner";
}

export function generateInvitationToken(): string {
  const randomBytes = crypto.getRandomValues(new Uint8Array(32));
  return Array.from(randomBytes, (byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function sha256Hex(rawToken: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(rawToken),
  );
  return Array.from(
    new Uint8Array(digest),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
}

export function wouldDemoteLastOwner(
  currentRole: WorkspaceRole,
  nextRole: WorkspaceRole,
  ownerCount: number,
): boolean {
  return currentRole === "owner" && nextRole !== "owner" && ownerCount <= 1;
}

export function wouldRemoveLastOwner(
  currentRole: WorkspaceRole,
  ownerCount: number,
): boolean {
  return currentRole === "owner" && ownerCount <= 1;
}

interface ActionContext {
  body: Record<string, unknown>;
  caller: AuthenticatedCaller;
  client: WorkspaceClient;
  dependencies: WorkspaceHandlerDependencies;
}

function isWorkspaceRole(role: unknown): role is WorkspaceRole {
  return typeof role === "string" && Object.hasOwn(WORKSPACE_ROLE_RANK, role);
}

function isInvitationRole(role: unknown): role is InvitationRole {
  return role === "admin" || role === "agent" || role === "viewer";
}

function requiredString(
  body: Record<string, unknown>,
  field: string,
): string {
  const fieldValue = body[field];
  if (typeof fieldValue !== "string" || fieldValue.length === 0) {
    throw new ApiError(400, `${field} is required`);
  }
  return fieldValue;
}

async function workspaceRoleFor(
  context: ActionContext,
): Promise<WorkspaceRole> {
  const workspaceId = requiredString(context.body, "workspace_id");
  const role = await context.client.workspaceRole(
    workspaceId,
    context.caller.userId,
  );
  if (!canReadWorkspace(role)) throw new ApiError(404, WORKSPACE_NOT_FOUND);
  return role;
}

async function requireWorkspaceManager(
  context: ActionContext,
): Promise<WorkspaceRole> {
  const role = await workspaceRoleFor(context);
  if (!canManageWorkspace(role)) throw new ApiError(403, "Forbidden");
  return role;
}

function invitationRole(body: Record<string, unknown>): InvitationRole {
  if (body.role === "owner") {
    throw new ApiError(
      400,
      "Invitation role must be admin, agent, or viewer",
    );
  }
  if (!isInvitationRole(body.role)) {
    throw new ApiError(400, "Invalid invitation role");
  }
  return body.role;
}

function memberRole(body: Record<string, unknown>): WorkspaceRole {
  if (!isWorkspaceRole(body.role)) {
    throw new ApiError(400, "Invalid workspace role");
  }
  return body.role;
}

function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function invitationExpiresAt(now: Date): string {
  return new Date(now.getTime() + INVITATION_TTL_MS).toISOString();
}

async function listWorkspaces(context: ActionContext): Promise<Response> {
  await context.client.ensurePersonalWorkspace(context.caller.userId);
  const workspaces = await context.client.listWorkspaces(context.caller.userId);
  return jsonResponse({ workspaces });
}

async function listMembers(context: ActionContext): Promise<Response> {
  await workspaceRoleFor(context);
  const workspaceId = requiredString(context.body, "workspace_id");
  const members = await context.client.listMembers(workspaceId);
  return jsonResponse({ members });
}

async function listInvitations(context: ActionContext): Promise<Response> {
  await requireWorkspaceManager(context);
  const workspaceId = requiredString(context.body, "workspace_id");
  const invitations = await context.client.listPendingInvitations(
    workspaceId,
    context.dependencies.now().toISOString(),
  );
  return jsonResponse({ invitations });
}

function publicInvitation(invitation: WorkspaceInvitation) {
  return {
    id: invitation.id,
    workspace_id: invitation.workspace_id,
    email: invitation.email,
    role: invitation.role,
    expires_at: invitation.expires_at,
    created_at: invitation.created_at,
  };
}

async function sendPersistedInvitation(
  context: ActionContext,
  invitation: WorkspaceInvitation,
  rawToken: string,
): Promise<void> {
  try {
    await context.dependencies.sendInvitationEmail({
      to: invitation.email,
      workspaceName: await context.client.workspaceName(
        invitation.workspace_id,
      ),
      rawToken,
    });
  } catch (_emailError) {
    await context.client.revokeInvitation(
      invitation.workspace_id,
      invitation.id,
      context.dependencies.now().toISOString(),
    );
    throw new ApiError(502, "Unable to send workspace invitation");
  }
}

async function inviteMember(context: ActionContext): Promise<Response> {
  await requireWorkspaceManager(context);
  const workspaceId = requiredString(context.body, "workspace_id");
  const email = normalizeEmail(requiredString(context.body, "email"));
  const role = invitationRole(context.body);
  if (!validEmail(email)) throw new ApiError(400, "Invalid email address");
  if (await context.client.isEmailMember(workspaceId, email)) {
    throw new ApiError(409, "User is already a workspace member");
  }

  const rawToken = context.dependencies.generateToken();
  const invitation = await context.client.createInvitation({
    workspace_id: workspaceId,
    email,
    role,
    token_hash: await sha256Hex(rawToken),
    invited_by: context.caller.userId,
    expires_at: invitationExpiresAt(context.dependencies.now()),
  });
  await sendPersistedInvitation(context, invitation, rawToken);
  return jsonResponse({ invitation: publicInvitation(invitation) }, 201);
}

async function acceptInvitation(context: ActionContext): Promise<Response> {
  const rawToken = requiredString(context.body, "token");
  const workspaceId = await context.client.acceptInvitation(rawToken);
  return jsonResponse({ workspace_id: workspaceId });
}

async function revokeInvitation(context: ActionContext): Promise<Response> {
  await requireWorkspaceManager(context);
  const workspaceId = requiredString(context.body, "workspace_id");
  const invitationId = requiredString(context.body, "invitation_id");
  const revoked = await context.client.revokeInvitation(
    workspaceId,
    invitationId,
    context.dependencies.now().toISOString(),
  );
  if (!revoked) throw new ApiError(404, "Invitation not found");
  return jsonResponse({ success: true });
}

async function targetMember(context: ActionContext): Promise<WorkspaceMember> {
  const workspaceId = requiredString(context.body, "workspace_id");
  const userId = requiredString(context.body, "user_id");
  const member = await context.client.member(workspaceId, userId);
  if (!member) throw new ApiError(404, "Member not found");
  return member;
}

async function assertOwnerCanChange(
  context: ActionContext,
  member: WorkspaceMember,
  nextRole?: WorkspaceRole,
): Promise<void> {
  if (member.role !== "owner") return;
  const ownerCount = await context.client.countOwners(member.workspace_id);
  const blocked = nextRole === undefined
    ? wouldRemoveLastOwner(member.role, ownerCount)
    : wouldDemoteLastOwner(member.role, nextRole, ownerCount);
  if (blocked) throw new ApiError(409, LAST_OWNER_ERROR);
}

async function changeMemberRole(context: ActionContext): Promise<Response> {
  const callerRole = await requireWorkspaceManager(context);
  const nextRole = memberRole(context.body);
  const member = await targetMember(context);
  // Only an owner may grant ownership or change an existing owner's role.
  // Without this, an admin could promote itself to owner and then unseat the
  // original owner. See canChangeOwnership.
  if (
    (nextRole === "owner" || member.role === "owner") &&
    !canChangeOwnership(callerRole)
  ) {
    throw new ApiError(403, "Forbidden");
  }
  await assertOwnerCanChange(context, member, nextRole);
  const updatedMember = await context.client.changeMemberRole(
    member.workspace_id,
    member.user_id,
    nextRole,
  );
  return jsonResponse({ member: updatedMember });
}

async function removeMember(context: ActionContext): Promise<Response> {
  const callerRole = await workspaceRoleFor(context);
  const member = await targetMember(context);
  const leaving = member.user_id === context.caller.userId;
  if (!leaving && !canManageWorkspace(callerRole)) {
    throw new ApiError(403, "Forbidden");
  }
  // An admin must not be able to unseat an owner; only another owner may remove
  // one. Owners may still leave voluntarily, subject to the last-owner guard.
  if (!leaving && member.role === "owner" && !canChangeOwnership(callerRole)) {
    throw new ApiError(403, "Forbidden");
  }
  await assertOwnerCanChange(context, member);
  await context.client.removeMember(member.workspace_id, member.user_id);
  return jsonResponse({ success: true });
}

async function dispatchAction(
  action: string,
  context: ActionContext,
): Promise<Response> {
  switch (action) {
    case "list_workspaces":
      return await listWorkspaces(context);
    case "list_members":
      return await listMembers(context);
    case "list_invitations":
      return await listInvitations(context);
    case "invite_member":
      return await inviteMember(context);
    case "revoke_invitation":
      return await revokeInvitation(context);
    case "accept_invitation":
      return await acceptInvitation(context);
    case "change_member_role":
      return await changeMemberRole(context);
    case "remove_member":
      return await removeMember(context);
    default:
      throw new ApiError(400, "Unknown action");
  }
}

async function requestBody(req: Request): Promise<Record<string, unknown>> {
  try {
    const body = await req.json();
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new ApiError(400, "JSON body must be an object");
    }
    return body as Record<string, unknown>;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    throw new ApiError(400, "Invalid JSON body");
  }
}

async function authenticatedCaller(
  dependencies: WorkspaceHandlerDependencies,
  req: Request,
): Promise<AuthenticatedCaller> {
  try {
    return await dependencies.authenticate(req);
  } catch (_authenticationError) {
    throw new ApiError(401, "Unauthorized");
  }
}

function failureResponse(error: unknown): Response {
  if (error instanceof ApiError) {
    return jsonResponse({ error: error.message }, error.status);
  }
  if (error instanceof InvitationAcceptanceError) {
    return jsonResponse({ error: error.message }, 400);
  }
  if (
    error instanceof WorkspaceClientError && error.message === LAST_OWNER_ERROR
  ) {
    return jsonResponse({ error: LAST_OWNER_ERROR }, 409);
  }
  if (error instanceof WorkspaceClientError && error.code === "23505") {
    return jsonResponse({ error: "Invitation already pending" }, 409);
  }
  return jsonResponse({ error: "Internal server error" }, 500);
}

export function createWorkspaceHandler(
  dependencies: WorkspaceHandlerDependencies,
): (req: Request) => Promise<Response> {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return handleCorsOptions();
    if (req.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, 405);
    }
    try {
      const body = await requestBody(req);
      const caller = await authenticatedCaller(dependencies, req);
      const action = requiredString(body, "action");
      const client = dependencies.clientFor(req);
      return await dispatchAction(action, {
        body,
        caller,
        client,
        dependencies,
      });
    } catch (error) {
      return failureResponse(error);
    }
  };
}
