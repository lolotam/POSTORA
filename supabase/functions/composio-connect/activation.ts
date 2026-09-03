// Turning a Composio account into an active Postora connection — shared by
// the OAuth callback (when Composio does redirect) and the finalize poll (the
// path the app relies on, because Composio's hosted Link page ends on its own
// "Successfully connected" screen and never returns the browser; verified
// 2026-09-03 in a headless browser against a real session).
import {
  COMPOSIO_REQUEST_TIMEOUT_MS,
  type ComposioConnectedAccount,
  ComposioError,
} from "../_shared/composioClient.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import type {
  ComposioConnectDependencies,
  PendingConnection,
} from "./dependencies.ts";

export interface ActivationInput {
  /** The nonce the row still carries; the activating write is a CAS on it. */
  nonce: string;
  /** The `/profiles` tab a YouTube channel lands on; absent elsewhere. */
  socialProfileId: string | null | undefined;
}

function firstString(...candidates: unknown[]): string | null {
  return candidates.find((value): value is string =>
    typeof value === "string" && value.length > 0
  ) ?? null;
}

/**
 * The account this flow created: newest ACTIVE one under the row's auth
 * config, created since the row. Composio's listing is the source of truth
 * when no account id reached us (the Link page never forwards one).
 */
export async function findFreshActiveAccount(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
): Promise<ComposioConnectedAccount | null> {
  if (!deps.composio) throw new ComposioError("composio_unavailable");
  const rowCreatedAt = Date.parse(connection.createdAt);
  return (await deps.composio.listConnectedAccounts(connection.workspaceId))
    .filter((account) =>
      account.status === "ACTIVE" &&
      account.authConfigId === connection.authConfigId &&
      Date.parse(account.createdAt) >= rowCreatedAt
    )
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0] ??
    null;
}

/** Why an account may not activate this row, or null when it may. */
export function accountRefusal(
  account: ComposioConnectedAccount,
  connection: PendingConnection,
): "connection_not_found" | "tenancy_mismatch" | null {
  if (
    account.status !== "ACTIVE" ||
    account.authConfigId !== connection.authConfigId
  ) return "connection_not_found";
  if (account.userId !== connection.workspaceId) return "tenancy_mismatch";
  return null;
}

function callbackLedger(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  errorCode: string,
): Promise<void> {
  return deps.recordCall({
    workspaceId: connection.workspaceId,
    connectionId: connection.id,
    connectorType: connection.connectorType,
    authStrategy: "composio_oauth",
    actionName: "callback",
    source: "test",
  }, { status: "refused", errorCode });
}

/** Marks the row failed with the code and records the refusal. */
export async function markFailed(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  code: string,
): Promise<void> {
  await deps.updateConnection(connection.id, {
    status: "failed",
    failure_code: code,
    state_nonce: null,
  });
  await callbackLedger(deps, connection, code);
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
  socialProfileId: string | null | undefined,
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
      // Omitted when no tab was chosen so a reconnect keeps the tab the
      // channel already lives on.
      ...(socialProfileId ? { social_profile_id: socialProfileId } : {}),
    });
  }
  return null;
}

/**
 * Cache the registry schemas, activate the row (compare-and-swap on the
 * nonce), and for YouTube home the channels. Returns "ok", "invalid_state"
 * when another activation won the race (the row is left alone), or the
 * refusal code the row was just failed with.
 */
export async function activateConnection(
  deps: ComposioConnectDependencies,
  connection: PendingConnection,
  input: ActivationInput,
  account: ComposioConnectedAccount,
): Promise<"ok" | string> {
  const binding = composioBinding(connection.connectorType);
  if (!binding || !deps.composio) {
    await markFailed(deps, connection, "connection_not_found");
    return "connection_not_found";
  }
  let schemas;
  try {
    schemas = await deps.composio.listTools(
      binding.toolkit,
      binding.tools,
      binding.toolkitVersion,
    );
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    await markFailed(deps, connection, "connector_unavailable");
    return "connector_unavailable";
  }
  const external = externalAccountMetadata(account);
  const now = new Date(deps.now()).toISOString();
  const activated = await deps.activateConnection(connection.id, input.nonce, {
    status: "active",
    failure_code: null,
    state_nonce: null,
    composio_connected_account_id: account.id,
    external_account_id: external.id,
    external_account_label: external.label,
    tool_schema_cache: schemas,
    tool_schema_cached_at: now,
    connected_at: now,
  });
  if (!activated) {
    await callbackLedger(deps, connection, "invalid_state");
    return "invalid_state";
  }
  if (connection.connectorType !== "youtube") return "ok";

  let channelError: string | null;
  try {
    channelError = await upsertYouTubeChannels(
      deps,
      connection,
      account.id,
      input.socialProfileId,
    );
  } catch {
    // Activation happens before channel discovery by contract. Any database
    // failure must therefore move the connection back to a failed state.
    channelError = "connector_unavailable";
  }
  if (channelError) {
    await markFailed(deps, connection, channelError);
    return channelError;
  }
  return "ok";
}
