export type WorkspaceRole = "owner" | "admin" | "agent" | "viewer";

export const WORKSPACE_ROLE_RANK: Record<WorkspaceRole, number> = {
  owner: 4,
  admin: 3,
  agent: 2,
  viewer: 1,
};

export function roleAtLeast(
  role: WorkspaceRole,
  minimum: WorkspaceRole,
): boolean {
  return WORKSPACE_ROLE_RANK[role] >= WORKSPACE_ROLE_RANK[minimum];
}

interface QueryResult {
  data: unknown;
  error: unknown;
}

export interface WhatsAppWorkspaceQuery {
  select(columns: string): WhatsAppWorkspaceQuery;
  eq(column: string, value: unknown): WhatsAppWorkspaceQuery;
  maybeSingle(): Promise<QueryResult>;
}

export interface WhatsAppWorkspaceAccessClient {
  from(table: string): WhatsAppWorkspaceQuery;
}

export interface WhatsAppAccountAccess {
  accountId: string;
  ownerId: string;
  workspaceId: string;
  role: WorkspaceRole;
  platformUserId: string;
  platformUsername: string | null;
  accessToken: string;
  connectionMode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  accountMetadata: unknown;
}

export type SafeWhatsAppAccount = Omit<WhatsAppAccountAccess, "accessToken">;

const ACCOUNT_NOT_FOUND_MESSAGE = "WhatsApp account not found";

export class WhatsAppAccessError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = "WhatsAppAccessError";
  }
}

interface SocialAccountRow {
  id: string;
  user_id: string;
  workspace_id: string | null;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  access_token: string | null;
  connection_mode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  account_metadata: unknown;
}

function isWorkspaceRole(value: string): value is WorkspaceRole {
  return Object.hasOwn(WORKSPACE_ROLE_RANK, value);
}

function accountNotFound(): WhatsAppAccessError {
  return new WhatsAppAccessError(ACCOUNT_NOT_FOUND_MESSAGE, 404);
}

async function findSocialAccount(
  client: WhatsAppWorkspaceAccessClient,
  socialAccountId: string,
): Promise<SocialAccountRow | null> {
  const { data: account, error } = await client
    .from("social_accounts")
    .select(
      "id, user_id, workspace_id, platform, platform_user_id, platform_username, access_token, connection_mode, account_metadata",
    )
    .eq("id", socialAccountId)
    .maybeSingle();
  if (error) throw error;
  return account as SocialAccountRow | null;
}

async function resolveWorkspaceId(
  client: WhatsAppWorkspaceAccessClient,
  account: SocialAccountRow,
): Promise<string> {
  if (account.workspace_id) return account.workspace_id;
  const { data: workspace, error } = await client
    .from("workspaces")
    .select("id")
    .eq("owner_id", account.user_id)
    .eq("is_personal", true)
    .maybeSingle();
  if (error) throw error;
  if (!workspace) throw accountNotFound();
  return (workspace as { id: string }).id;
}

async function findWorkspaceRole(
  client: WhatsAppWorkspaceAccessClient,
  workspaceId: string,
  userId: string,
): Promise<WorkspaceRole | null> {
  const { data: member, error } = await client
    .from("workspace_members")
    .select("role")
    .eq("workspace_id", workspaceId)
    .eq("user_id", userId)
    .maybeSingle();
  if (error) throw error;
  if (!member) return null;
  const role = (member as { role: string }).role;
  if (!isWorkspaceRole(role)) {
    throw new Error("Workspace member has an invalid role");
  }
  return role;
}

export async function requireWhatsAppWorkspaceAccess(
  client: WhatsAppWorkspaceAccessClient,
  userId: string,
  socialAccountId: string,
  minimumRole: WorkspaceRole = "viewer",
): Promise<WhatsAppAccountAccess> {
  const account = await findSocialAccount(client, socialAccountId);
  if (!account) throw accountNotFound();
  if (account.platform !== "whatsapp") throw accountNotFound();

  const workspaceId = await resolveWorkspaceId(client, account);
  const role = await findWorkspaceRole(client, workspaceId, userId);
  if (!role) throw accountNotFound();
  if (!roleAtLeast(role, minimumRole)) {
    throw new WhatsAppAccessError(
      `WhatsApp workspace role '${minimumRole}' or above required`,
      403,
    );
  }

  return {
    accountId: account.id,
    ownerId: account.user_id,
    workspaceId,
    role,
    platformUserId: account.platform_user_id,
    platformUsername: account.platform_username,
    accessToken: account.access_token || "",
    connectionMode: account.connection_mode,
    accountMetadata: account.account_metadata,
  };
}

export function toSafeWhatsAppAccount(
  access: WhatsAppAccountAccess,
): SafeWhatsAppAccount {
  return {
    accountId: access.accountId,
    ownerId: access.ownerId,
    workspaceId: access.workspaceId,
    role: access.role,
    platformUserId: access.platformUserId,
    platformUsername: access.platformUsername,
    connectionMode: access.connectionMode,
    accountMetadata: access.accountMetadata,
  };
}
