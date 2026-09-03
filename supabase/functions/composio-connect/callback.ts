import {
  COMPOSIO_CALLBACK_ACCOUNT_PARAM,
  ComposioError,
} from "../_shared/composioClient.ts";
import { composioBinding } from "../_shared/connectorRegistry.ts";
import { verifyConnectState } from "../_shared/composioState.ts";
import type {
  ComposioConnectDependencies,
  PendingConnection,
} from "./dependencies.ts";

function redirect(
  deps: ComposioConnectDependencies,
  result: string,
  connectionId?: string,
): Response {
  const location = new URL(deps.appReturnUrl);
  if (connectionId) location.searchParams.set("connection", connectionId);
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
  return redirect(deps, code, connection.id);
}

function externalAccountMetadata(metadata: Record<string, unknown>): {
  id: string | null;
  label: string | null;
} {
  const id = [metadata.id, metadata.email, metadata.account_id]
    .find((value) => typeof value === "string") as string | undefined;
  const label = [metadata.name, metadata.label, metadata.email]
    .find((value) => typeof value === "string") as string | undefined;
  return { id: id ?? null, label: label ?? null };
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
    if (connection) {
      await deps.recordCall({
        workspaceId: connection.workspaceId,
        connectionId: connection.id,
        connectorType: connection.connectorType,
        authStrategy: "composio_oauth",
        actionName: "callback",
        source: "test",
      }, { status: "refused", errorCode: "invalid_state" });
    }
    return redirect(deps, "invalid_state", connection?.id);
  }

  const accountId = url.searchParams.get(COMPOSIO_CALLBACK_ACCOUNT_PARAM);
  if (!accountId || !deps.composio) {
    return await refuse(
      deps,
      connection,
      accountId ? "connector_unavailable" : "connection_not_found",
    );
  }

  let account;
  try {
    account = await deps.composio.getConnectedAccount(accountId);
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    return await refuse(deps, connection, "connector_unavailable");
  }
  if (
    account.status !== "ACTIVE" ||
    account.authConfigId !== connection.authConfigId
  ) {
    return await refuse(deps, connection, "connection_not_found");
  }
  if (account.userId !== state.workspaceId) {
    return await refuse(deps, connection, "tenancy_mismatch");
  }

  const binding = composioBinding(connection.connectorType);
  if (!binding) return await refuse(deps, connection, "connection_not_found");
  let schemas;
  try {
    schemas = await deps.composio.listTools(
      binding.toolkit,
      binding.tools,
      binding.toolkitVersion,
    );
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    return await refuse(deps, connection, "connector_unavailable");
  }
  const external = externalAccountMetadata(account.metadata);
  await deps.updateConnection(connection.id, {
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
  return redirect(deps, "ok", connection.id);
}
