import {
  COMPOSIO_CALLBACK_ACCOUNT_PARAMS,
  COMPOSIO_CALLBACK_STATUS_PARAM,
  COMPOSIO_REQUEST_TIMEOUT_MS,
  type ComposioConnectedAccount,
  ComposioError,
} from "../_shared/composioClient.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import { type ConnectState, verifyConnectState } from "../_shared/composioState.ts";
import type {
  ComposioConnectDependencies,
  PendingConnection,
} from "./dependencies.ts";

/** A YouTube connect starts on `/profiles`, so it ends there; every other
 *  connector returns to the integrations tab it was started from. */
function returnUrlFor(
  deps: ComposioConnectDependencies,
  connectorType: string | undefined,
): URL {
  return connectorType === "youtube"
    ? new URL("/profiles", deps.appReturnUrl)
    : new URL(deps.appReturnUrl);
}

function redirect(
  deps: ComposioConnectDependencies,
  result: string,
  connection?: Pick<PendingConnection, "id" | "connectorType">,
): Response {
  const location = returnUrlFor(deps, connection?.connectorType);
  if (connection) location.searchParams.set("connection", connection.id);
  location.searchParams.set("result", result);
  return new Response(null, {
    status: 302,
    headers: { location: location.toString(), "cache-control": "no-store" },
  });
}

async function refuse(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  code: string,
): Promise<Response> {
  await deps.updateConnection(connection.id, {
    status: "failed",
    failure_code: code,
    state_nonce: null,
  });
  await deps.recordCall({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    connectorType: connection.connectorType,
    authStrategy: "composio_oauth",
    actionName: "callback",
    source: "test",
  }, { status: "refused", errorCode: code });
  return redirect(deps, code, connection);
}

function firstString(...candidates: unknown[]): string | null {
  return candidates.find((value): value is string =>
    typeof value === "string" && value.length > 0
  ) ?? null;
}

/** Provider metadata first; Composio's own alias and word id are the fallback
 *  label because the live listing carries no metadata at all (spike 2026-09-03). */
function externalAccountMetadata(account: ComposioConnectedAccount): {
  id: string | null;
  label: string | null;
} {
  const metadata = account.metadata;
  return {
    id: firstString(metadata.id, metadata.email, metadata.account_id),
    label: firstString(
      metadata.name,
      metadata.label,
      metadata.email,
      account.alias,
      account.wordId,
    ),
  };
}

type AccountResolution =
  | { ok: true; account: ComposioConnectedAccount }
  | { ok: false; code: "connection_not_found" | "connector_unavailable" };

/**
 * Composio's docs show two spellings of the id parameter and a `status`
 * parameter; a failed authorisation is refused before any provider call. When
 * no id arrives at all, the account is the newest ACTIVE one under this
 * connection's auth config created since the row — the one this flow made.
 */
async function resolveConnectedAccount(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  url: URL,
): Promise<AccountResolution> {
  if (url.searchParams.get(COMPOSIO_CALLBACK_STATUS_PARAM) === "failed") {
    return { ok: false, code: "connection_not_found" };
  }
  if (!deps.composio) return { ok: false, code: "connector_unavailable" };
  const accountId = firstString(
    ...COMPOSIO_CALLBACK_ACCOUNT_PARAMS.map((name) => url.searchParams.get(name)),
  );
  try {
    if (accountId) {
      return { ok: true, account: await deps.composio.getConnectedAccount(accountId) };
    }
    const rowCreatedAt = Date.parse(connection.createdAt);
    const candidate = (await deps.composio.listConnectedAccounts(connection.workspaceId))
      .filter((account) =>
        account.status === "ACTIVE" &&
        account.authConfigId === connection.authConfigId &&
        Date.parse(account.createdAt) >= rowCreatedAt
      )
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0];
    return candidate
      ? { ok: true, account: candidate }
      : { ok: false, code: "connection_not_found" };
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    return { ok: false, code: "connector_unavailable" };
  }
}

interface YouTubeChannel {
  id: string;
  title: string;
  avatarUrl: string | null;
}

function youtubeChannels(data: unknown): YouTubeChannel[] {
  const record = data && typeof data === "object"
    ? data as Record<string, unknown>
    : null;
  const raw = Array.isArray(data)
    ? data
    : Array.isArray(record?.items)
    ? record.items
    : Array.isArray(record?.channels)
    ? record.channels
    : [];
  return raw.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const row = value as Record<string, unknown>;
    const snippet = row.snippet && typeof row.snippet === "object"
      ? row.snippet as Record<string, unknown>
      : {};
    if (typeof row.id !== "string" || typeof snippet.title !== "string") {
      return [];
    }
    const thumbnails =
      snippet.thumbnails && typeof snippet.thumbnails === "object"
        ? snippet.thumbnails as Record<string, unknown>
        : {};
    const preferred = thumbnails.high ?? thumbnails.medium ??
      thumbnails.default;
    const avatarUrl = preferred && typeof preferred === "object" &&
        typeof (preferred as Record<string, unknown>).url === "string"
      ? (preferred as Record<string, unknown>).url as string
      : null;
    return [{ id: row.id, title: snippet.title, avatarUrl }];
  });
}

async function listYouTubeChannels(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  connectedAccountId: string,
): Promise<YouTubeChannel[] | null> {
  const binding = composioBinding("youtube");
  if (!deps.composio || !binding) return null;
  const ledger = (status: "success" | "failed", errorCode: string | null) =>
    deps.recordCall({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      connectorType: "youtube",
      authStrategy: "composio_oauth",
      actionName: "YOUTUBE_LIST_CHANNELS",
      source: "test",
    }, { status, errorCode });
  let response;
  try {
    response = await deps.composio.executeTool({
      slug: "YOUTUBE_LIST_CHANNELS",
      version: binding.toolkitVersion,
      workspaceId: connection.workspaceId,
      connectedAccountId,
      arguments: { mine: true },
      signal: AbortSignal.timeout(COMPOSIO_REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    await ledger(
      "failed",
      error instanceof ComposioError ? error.code : "connector_failure",
    );
    return null;
  }
  await ledger(
    response.successful ? "success" : "failed",
    response.successful ? null : "connector_failure",
  );
  return response.successful ? youtubeChannels(response.data) : null;
}

/** Returns the refusal code, or null when every channel is now a social account. */
async function upsertYouTubeChannels(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  connectedAccountId: string,
  socialProfileId: string | undefined,
): Promise<string | null> {
  const channels = await listYouTubeChannels(deps, connection, connectedAccountId);
  if (channels === null) return "connector_unavailable";
  if (channels.length === 0) return "no_channel";

  for (const channel of channels) {
    const provider = await deps.loadSocialAccountProvider(
      connection.initiatedBy,
      "youtube",
      channel.id,
    );
    if (provider === "native") return "channel_already_native";
  }
  for (const channel of channels) {
    await deps.upsertSocialAccount({
      user_id: connection.initiatedBy,
      workspace_id: connection.workspaceId,
      platform: "youtube",
      platform_user_id: channel.id,
      platform_username: channel.title,
      avatar_url: channel.avatarUrl,
      access_token: null,
      refresh_token: null,
      token_expires_at: null,
      auth_provider: "composio",
      connection_id: connection.id,
      is_active: true,
      needs_reauth: false,
      // Omitted when the state carries none so a reconnect keeps the tab the
      // channel already lives on.
      ...(socialProfileId ? { social_profile_id: socialProfileId } : {}),
    });
  }
  return null;
}

async function recordInvalidState(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
): Promise<void> {
  await deps.recordCall({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    connectorType: connection.connectorType,
    authStrategy: "composio_oauth",
    actionName: "callback",
    source: "test",
  }, { status: "refused", errorCode: "invalid_state" });
}

async function activate(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  state: ConnectState,
  account: ComposioConnectedAccount,
): Promise<Response> {
  const binding = composioBinding(connection.connectorType);
  if (!binding) return await refuse(deps, connection, "connection_not_found");
  let schemas;
  try {
    schemas = await deps.composio!.listTools(
      binding.toolkit,
      binding.tools,
      binding.toolkitVersion,
    );
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    return await refuse(deps, connection, "connector_unavailable");
  }
  const external = externalAccountMetadata(account);
  // Compare-and-swap on (status, nonce): the read at the top proved the state
  // matched, but two callbacks replaying one state could both have passed it.
  // Only the write that still finds the nonce activates; the other is a replay.
  const activated = await deps.activateConnection(connection.id, state.nonce, {
    status: "active",
    failure_code: null,
    state_nonce: null,
    composio_connected_account_id: account.id,
    external_account_id: external.id,
    external_account_label: external.label,
    tool_schema_cache: schemas,
    tool_schema_cached_at: new Date(deps.now()).toISOString(),
    connected_at: new Date(deps.now()).toISOString(),
  });
  if (!activated) {
    await recordInvalidState(deps, connection);
    return redirect(deps, "invalid_state", connection);
  }
  if (connection.connectorType === "youtube") {
    let channelError: string | null;
    try {
      channelError = await upsertYouTubeChannels(
        deps,
        connection,
        account.id,
        state.socialProfileId,
      );
    } catch {
      // Activation happens before channel discovery by contract. Any database
      // failure must therefore move the connection back to a failed state.
      channelError = "connector_unavailable";
    }
    if (channelError) return await refuse(deps, connection, channelError);
  }
  return redirect(deps, "ok", connection);
}

export async function composioCallbackResponse(
  deps: ComposioConnectDependencies,
  url: URL,
): Promise<Response> {
  if (!deps.stateSecret) return redirect(deps, "invalid_state");
  const state = await verifyConnectState(
    url.searchParams.get("state") ?? "",
    deps.stateSecret,
    deps.now,
  );
  if (!state) return redirect(deps, "invalid_state");

  const connection = await deps.loadPendingConnection(
    state.connectionId,
    state.workspaceId,
  );
  if (
    !connection || connection.status !== "initiated" ||
    connection.stateNonce !== state.nonce
  ) {
    if (connection) await recordInvalidState(deps, connection);
    return redirect(deps, "invalid_state", connection ?? undefined);
  }

  const resolved = await resolveConnectedAccount(deps, connection, url);
  if (!resolved.ok) return await refuse(deps, connection, resolved.code);
  const { account } = resolved;
  if (
    account.status !== "ACTIVE" ||
    account.authConfigId !== connection.authConfigId
  ) {
    return await refuse(deps, connection, "connection_not_found");
  }
  if (account.userId !== state.workspaceId) {
    return await refuse(deps, connection, "tenancy_mismatch");
  }
  return await activate(deps, connection, state, account);
}
