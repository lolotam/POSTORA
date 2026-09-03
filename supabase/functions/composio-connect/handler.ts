import { composioBinding } from "../_shared/connectorRegistry.ts";
import {
  ComposioInitiateError,
  initiateComposioConnection,
} from "../_shared/composioInitiate.ts";
import type { ComposioConnectDependencies } from "./dependencies.ts";

export { COMPOSIO_CONNECT_STATE_TTL_SECONDS } from "../_shared/composioInitiate.ts";

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

/**
 * The app door's initiate: prove MEMBERSHIP, then mint the link with the one
 * shared implementation (`_shared/composioInitiate.ts`).
 *
 * The membership check stays here because it is this door's authorisation and
 * nothing else's — the partner door proves its key's workspace instead. Every
 * step after it is identical for both doors, which is why it lives in `_shared`
 * and not in two places.
 */
export async function initiateConnection(
  deps: ComposioConnectDependencies,
  input: {
    userId: string;
    workspaceId: string;
    connectorType: string;
    socialProfileId?: string | null;
  },
): Promise<{
  connection_id: string;
  redirect_url: string;
  expires_at: string;
}> {
  if (!(await deps.isWorkspaceMember(input.userId, input.workspaceId))) {
    throw new ConnectError("forbidden", 403);
  }
  try {
    return await initiateComposioConnection(
      deps,
      {
        workspaceId: input.workspaceId,
        connectorType: input.connectorType,
        initiatedBy: input.userId,
        socialProfileId: input.socialProfileId ?? null,
      },
      // The source this door has written since Slice B. Kept verbatim so the
      // extraction changes no row the Hub already renders.
      { source: "test" },
    );
  } catch (error) {
    if (error instanceof ComposioInitiateError) {
      throw new ConnectError(error.code, error.status);
    }
    throw error;
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
