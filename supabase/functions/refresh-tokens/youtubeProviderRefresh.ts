import type { ComposioClient } from "../_shared/composioClient.ts";
import {
  ConnectorRefusal,
  resolveWorkspaceForCall,
  withConnectorCall,
} from "../_shared/connectorTelemetry.ts";
import {
  createSupabaseYouTubeRefreshStore,
  refreshYouTubeAccountToken,
  type GoogleRefreshExchangeResult,
  type YouTubeRefreshStore,
} from "../_shared/youtubeTokenRefresh.ts";

export const COMPOSIO_YOUTUBE_REAUTH_MESSAGE =
  "Token limit exceeded. Please reconnect your account.";

const ALERT_COOLDOWN_MS = 24 * 60 * 60 * 1000;

export interface NativeYouTubeAccountSnapshot {
  id: string;
  user_id: string;
  access_token?: string | null;
  refresh_token?: string | null;
  token_expires_at?: string | null;
  needs_reauth?: boolean | null;
  alerts_snoozed?: boolean | null;
  last_alert_sent_at?: string | null;
}

export interface NativeYouTubeRefreshResult {
  status:
    | "refreshed"
    | "already_refreshed"
    | "cooldown"
    | "needs_reauth"
    | "failed";
  accessToken?: string;
  error?: string;
  shouldAlert: boolean;
}

export async function refreshNativeYouTubeAccount(
  account: NativeYouTubeAccountSnapshot,
  deps: {
    admin: unknown;
    force?: boolean;
    /** Administrator recovery: allow the exchange for a needs_reauth account. */
    adminRecovery?: boolean;
    maxFailures?: number;
    store?: YouTubeRefreshStore;
    exchange?: (refreshToken: string) => Promise<GoogleRefreshExchangeResult>;
    fetchImpl?: typeof fetch;
    nowMs?: () => number;
  },
): Promise<NativeYouTubeRefreshResult> {
  const nowMs = deps.nowMs ?? (() => Date.now());
  const now = nowMs();
  const lastAlertMs = account.last_alert_sent_at
    ? Date.parse(account.last_alert_sent_at)
    : Number.NaN;
  const canAlert = !account.alerts_snoozed &&
    (!Number.isFinite(lastAlertMs) || now - lastAlertMs > ALERT_COOLDOWN_MS);

  const outcome = await refreshYouTubeAccountToken({
    accountId: account.id,
    snapshot: {
      access_token: account.access_token ?? null,
      refresh_token: account.refresh_token ?? null,
      token_expires_at: account.token_expires_at ?? null,
      needs_reauth: account.needs_reauth ?? false,
    },
    force: deps.force ?? false,
    adminRecovery: deps.adminRecovery ?? false,
    recordTransientFailure: true,
    maxFailures: deps.maxFailures ?? 3,
    lastAlertSentAt: canAlert ? new Date(now).toISOString() : null,
    store: deps.store ?? createSupabaseYouTubeRefreshStore(deps.admin),
    exchange: deps.exchange,
    fetchImpl: deps.fetchImpl,
    nowMs,
  });

  if (outcome.ok) {
    return {
      status: outcome.status === "refreshed" ? "refreshed" : "already_refreshed",
      accessToken: outcome.accessToken,
      shouldAlert: false,
    };
  }

  if (outcome.status === "needs_reauth") {
    return {
      status: "needs_reauth",
      error: COMPOSIO_YOUTUBE_REAUTH_MESSAGE,
      shouldAlert: canAlert && outcome.transitioned !== false,
    };
  }

  if (outcome.status === "retryable_refusal") {
    if (outcome.reason === "refresh_in_progress") {
      return {
        status: "cooldown",
        error: "Refresh already in progress",
        shouldAlert: false,
      };
    }
    return {
      status: "failed",
      error: outcome.reason,
      shouldAlert: false,
    };
  }

  return {
    status: "failed",
    error: outcome.reason === "no_refresh_token"
      ? "No refresh token available"
      : "Could not refresh token",
    shouldAlert: canAlert,
  };
}

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
