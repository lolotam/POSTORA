import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

import {
  type ComposioClient,
  composioClientFromEnv,
} from "../_shared/composioClient.ts";
import { composioAuthConfigFor } from "../_shared/composioInitiate.ts";
import {
  type ConnectorCallMeta,
  type ConnectorCallOutcome,
  recordConnectorCall,
} from "../_shared/connectorTelemetry.ts";

export const DEFAULT_APP_RETURN_URL =
  "https://postora.cloud/settings?tab=integrations";
// Re-exported, not re-declared: the partner door reads the same variables, and
// two spellings of the name would be a connector that connects from one door
// and reports connector_unavailable from the other.
export { COMPOSIO_AUTH_CONFIG_PREFIX } from "../_shared/composioInitiate.ts";

export interface PendingConnection {
  id: string;
  workspaceId: string;
  connectorType: string;
  authConfigId: string;
  stateNonce: string | null;
  status: string;
  initiatedBy: string;
  createdAt: string;
}

export interface UserConnection {
  id: string;
  workspaceId: string;
  connectorType: string;
  composioConnectedAccountId: string | null;
  status: string;
  failureCode: string | null;
}

export interface ComposioConnectDependencies {
  composio: ComposioClient | null;
  stateSecret: string;
  callbackUrl: string;
  appReturnUrl: string;
  now: () => number;
  newId: () => string;
  authConfigFor: (connectorType: string) => string | undefined;
  isWorkspaceMember: (userId: string, workspaceId: string) => Promise<boolean>;
  insertConnection: (row: Record<string, unknown>) => Promise<void>;
  updateConnection: (
    id: string,
    values: Record<string, unknown>,
  ) => Promise<void>;
  /**
   * The activating write, as one compare-and-swap: it applies only while the
   * row is still `initiated` AND still carries this nonce, and reports whether
   * it did. Two callbacks replaying one signed state cannot both win.
   */
  activateConnection: (
    id: string,
    nonce: string,
    values: Record<string, unknown>,
  ) => Promise<boolean>;
  loadPendingConnection: (
    id: string,
    workspaceId: string,
  ) => Promise<PendingConnection | null>;
  loadConnectionForUser: (
    id: string,
    userId: string,
  ) => Promise<UserConnection | null>;
  revokeRpc: (userClient: any, connectionId: string) => Promise<void>;
  loadSocialAccountProvider: (
    userId: string,
    platform: string,
    platformUserId: string,
  ) => Promise<string | null>;
  /** Upsert on (user_id, platform, platform_user_id), the
   *  social_accounts_user_platform_unique constraint. */
  upsertSocialAccount: (row: Record<string, unknown>) => Promise<void>;
  recordCall: (
    meta: ConnectorCallMeta,
    outcome: ConnectorCallOutcome,
  ) => Promise<void>;
}

function throwDatabaseError(error: unknown): never {
  if (error instanceof Error) throw error;
  throw new Error("connector_database_error");
}

export function createUserClient(authorization: string): any {
  return createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_ANON_KEY")!,
    { global: { headers: { Authorization: authorization } } },
  );
}

export function createDependencies(): ComposioConnectDependencies {
  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const isWorkspaceMember = async (userId: string, workspaceId: string) => {
    const { data, error } = await admin
      .from("workspace_members")
      .select("workspace_id")
      .eq("workspace_id", workspaceId)
      .eq("user_id", userId)
      .maybeSingle();
    if (error) throwDatabaseError(error);
    return Boolean(data);
  };

  return {
    composio: composioClientFromEnv(),
    stateSecret: Deno.env.get("COMPOSIO_STATE_SECRET") ?? "",
    callbackUrl: Deno.env.get("COMPOSIO_CALLBACK_URL") ?? "",
    appReturnUrl: Deno.env.get("APP_RETURN_URL") ?? DEFAULT_APP_RETURN_URL,
    now: Date.now,
    // Wrapped on purpose: randomUUID is a Crypto method and throws
    // "Illegal invocation" when called detached from its receiver.
    newId: () => crypto.randomUUID(),
    authConfigFor: (connectorType) =>
      composioAuthConfigFor(connectorType, (name) => Deno.env.get(name)),
    isWorkspaceMember,
    async insertConnection(row) {
      const { error } = await admin.from("connector_connections").insert(row);
      if (error) throwDatabaseError(error);
    },
    async updateConnection(id, values) {
      const { error } = await admin.from("connector_connections").update({
        ...values,
        updated_at: new Date().toISOString(),
      }).eq("id", id);
      if (error) throwDatabaseError(error);
    },
    async activateConnection(id, nonce, values) {
      const { data, error } = await admin
        .from("connector_connections")
        .update({ ...values, updated_at: new Date().toISOString() })
        .eq("id", id)
        .eq("status", "initiated")
        .eq("state_nonce", nonce)
        .select("id");
      if (error) throwDatabaseError(error);
      return Array.isArray(data) && data.length === 1;
    },
    async loadPendingConnection(id, workspaceId) {
      const { data, error } = await admin
        .from("connector_connections")
        .select(
          "id,workspace_id,connector_type,composio_auth_config_id,state_nonce,status,initiated_by,created_at",
        )
        .eq("id", id)
        .eq("workspace_id", workspaceId)
        .maybeSingle();
      if (error) throwDatabaseError(error);
      if (!data) return null;
      return {
        id: data.id,
        workspaceId: data.workspace_id,
        connectorType: data.connector_type,
        authConfigId: data.composio_auth_config_id,
        stateNonce: data.state_nonce,
        status: data.status,
        initiatedBy: data.initiated_by,
        createdAt: data.created_at,
      };
    },
    async loadConnectionForUser(id, userId) {
      const { data, error } = await admin
        .from("connector_connections")
        .select(
          "id,workspace_id,connector_type,composio_connected_account_id,status,failure_code",
        )
        .eq("id", id)
        .maybeSingle();
      if (error) throwDatabaseError(error);
      if (!data || !(await isWorkspaceMember(userId, data.workspace_id))) {
        return null;
      }
      return {
        id: data.id,
        workspaceId: data.workspace_id,
        connectorType: data.connector_type,
        composioConnectedAccountId: data.composio_connected_account_id,
        status: data.status,
        failureCode: data.failure_code ?? null,
      };
    },
    async revokeRpc(userClient, connectionId) {
      const { error } = await userClient.rpc("revoke_connector_connection", {
        p_connection_id: connectionId,
      });
      if (error) throwDatabaseError(error);
    },
    async loadSocialAccountProvider(userId, platform, platformUserId) {
      const { data, error } = await admin.from("social_accounts")
        .select("auth_provider")
        .eq("user_id", userId)
        .eq("platform", platform)
        .eq("platform_user_id", platformUserId)
        .maybeSingle();
      if (error) throwDatabaseError(error);
      return data?.auth_provider ?? null;
    },
    async upsertSocialAccount(row) {
      const { error } = await admin.from("social_accounts").upsert(row, {
        onConflict: "user_id,platform,platform_user_id",
      });
      if (error) throwDatabaseError(error);
    },
    recordCall: (meta, outcome) => recordConnectorCall(admin, meta, outcome),
  };
}
