import {
  composioBinding,
  isComposioType,
} from "../_shared/connectorRegistry.ts";
import { ComposioError } from "../_shared/composioClient.ts";
import { newNonce, signConnectState } from "../_shared/composioState.ts";
import type { ComposioConnectDependencies } from "./dependencies.ts";

export const COMPOSIO_CONNECT_STATE_TTL_SECONDS = 10 * 60;

export class ConnectError extends Error {
  constructor(public readonly code: string, public readonly status: number) {
    super(code);
    this.name = "ConnectError";
  }
}

async function recordRefusal(
  deps: ComposioConnectDependencies,
  workspaceId: string,
  connectorType: string,
  actionName: string,
  code: string,
): Promise<void> {
  await deps.recordCall({
    workspaceId,
    connectorType,
    authStrategy: "composio_oauth",
    actionName,
    source: "test",
  }, { status: "refused", errorCode: code });
}

export async function initiateConnection(
  deps: ComposioConnectDependencies,
  input: { userId: string; workspaceId: string; connectorType: string },
): Promise<{
  connection_id: string;
  redirect_url: string;
  expires_at: string;
}> {
  if (!(await deps.isWorkspaceMember(input.userId, input.workspaceId))) {
    throw new ConnectError("forbidden", 403);
  }
  if (!isComposioType(input.connectorType)) {
    throw new ConnectError("connector_type_not_connectable", 400);
  }

  const binding = composioBinding(input.connectorType)!;
  const authConfigId = deps.authConfigFor(input.connectorType);
  if (
    !deps.composio || !authConfigId || !deps.stateSecret || !deps.callbackUrl
  ) {
    await recordRefusal(
      deps,
      input.workspaceId,
      input.connectorType,
      "connect_link",
      "connector_unavailable",
    );
    throw new ConnectError("connector_unavailable", 503);
  }

  const connectionId = deps.newId();
  const nonce = newNonce();
  const expiresAtSeconds = Math.floor(deps.now() / 1_000) +
    COMPOSIO_CONNECT_STATE_TTL_SECONDS;
  await deps.insertConnection({
    id: connectionId,
    workspace_id: input.workspaceId,
    connector_type: input.connectorType,
    toolkit: binding.toolkit,
    auth_strategy: "composio_oauth",
    composio_auth_config_id: authConfigId,
    status: "initiated",
    state_nonce: nonce,
    initiated_by: input.userId,
  });

  const state = await signConnectState({
    connectionId,
    workspaceId: input.workspaceId,
    nonce,
    exp: expiresAtSeconds,
  }, deps.stateSecret);
  const callbackUrl = new URL(deps.callbackUrl);
  callbackUrl.searchParams.set("state", state);

  try {
    const link = await deps.composio.initiateConnection({
      workspaceId: input.workspaceId,
      authConfigId,
      callbackUrl: callbackUrl.toString(),
    });
    return {
      connection_id: connectionId,
      redirect_url: link.redirectUrl,
      expires_at: new Date(expiresAtSeconds * 1_000).toISOString(),
    };
  } catch (error) {
    const errorCode = error instanceof ComposioError
      ? error.code
      : "composio_unavailable";
    await deps.updateConnection(connectionId, {
      status: "failed",
      failure_code: errorCode,
      state_nonce: null,
    });
    await deps.recordCall({
      workspaceId: input.workspaceId,
      connectionId,
      connectorType: input.connectorType,
      authStrategy: "composio_oauth",
      actionName: "connect_link",
      source: "test",
    }, { status: "failed", errorCode });
    throw new ConnectError("connector_unavailable", 503);
  }
}

export async function refreshConnectionSchema(
  deps: ComposioConnectDependencies,
  input: { userId: string; connectionId: string },
): Promise<{ ok: true }> {
  const connection = await deps.loadConnectionForUser(
    input.connectionId,
    input.userId,
  );
  if (!connection) throw new ConnectError("forbidden", 403);
  if (connection.status !== "active") {
    await recordRefusal(deps, connection.workspaceId, connection.connectorType, "refresh_schema", "connection_inactive");
    throw new ConnectError("connection_inactive", 409);
  }
  const binding = composioBinding(connection.connectorType);
  if (!deps.composio || !binding) {
    await recordRefusal(
      deps,
      connection.workspaceId,
      connection.connectorType,
      "refresh_schema",
      "connector_unavailable",
    );
    throw new ConnectError("connector_unavailable", 503);
  }
  const schemas = await deps.composio.listTools(
    binding.toolkit,
    binding.tools,
    binding.toolkitVersion,
  );
  await deps.updateConnection(connection.id, {
    tool_schema_cache: schemas,
    tool_schema_cached_at: new Date(deps.now()).toISOString(),
  });
  return { ok: true };
}
