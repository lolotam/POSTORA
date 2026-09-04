import type { ComposioClient } from "../_shared/composioClient.ts";
import {
  ConnectorRefusal,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "../_shared/connectorTelemetry.ts";

export const COMPOSIO_YOUTUBE_REAUTH_MESSAGE =
  "Token limit exceeded. Please reconnect your account.";

export interface ProviderAwareYouTubeAccount {
  id: string;
  user_id: string;
  auth_provider?: "native" | "composio";
  connection_id?: string | null;
  workspace_id?: string | null;
}

export interface YouTubeProviderProbeDeps<T> {
  admin: any;
  client: ComposioClient | null;
  refreshNative: () => Promise<T>;
  markInactive: () => Promise<void>;
}

export async function probeYouTubeProvider<T>(
  account: ProviderAwareYouTubeAccount,
  deps: YouTubeProviderProbeDeps<T>,
): Promise<
  { provider: "native"; result: T } | { provider: "composio"; active: boolean }
> {
  if (account.auth_provider !== "composio") {
    return { provider: "native", result: await deps.refreshNative() };
  }

  // social_accounts.workspace_id is nullable but connector_call_logs.workspace_id
  // is a NOT NULL uuid: the `?? ""` this replaces made the ledger insert throw
  // `invalid input syntax for type uuid` on every probe of an unbackfilled
  // account — the every-few-minutes failure that blinded the ledger from
  // 2026-09-03. Spec §4.3: the account's workspace, else the owner's personal.
  const workspaceId = account.workspace_id ??
    await resolveWorkspaceForCall(deps.admin, { userId: account.user_id });
  const meta = {
    workspaceId,
    connectionId: account.connection_id ?? null,
    socialAccountId: account.id,
    connectorType: "youtube",
    authStrategy: "composio_oauth" as const,
    actionName: "get_connected_account",
    source: "test" as const,
  };
  const remoteActive = await withConnectorCall(deps.admin, meta, async () => {
    if (!deps.client) throw new ConnectorRefusal("connector_unavailable");
    if (!account.connection_id) return false;
    const { data, error } = await deps.admin.from("connector_connections")
      .select("id,workspace_id,composio_connected_account_id,status")
      .eq("id", account.connection_id)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (error) throw new Error("connection_read_failed");
    if (
      !data || data.status !== "active" || !data.composio_connected_account_id
    ) return false;
    const connected = await deps.client.getConnectedAccount(
      data.composio_connected_account_id,
    );
    return connected.status === "ACTIVE";
  }, { timeoutMs: 5_000 });

  if (!remoteActive) await deps.markInactive();
  return { provider: "composio", active: remoteActive };
}
