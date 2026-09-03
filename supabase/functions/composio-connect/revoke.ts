import type { ComposioConnectDependencies } from "./dependencies.ts";
import { ComposioError } from "../_shared/composioClient.ts";
import { ConnectError } from "./handler.ts";

export async function revokeConnection(
  deps: ComposioConnectDependencies,
  input: { userId: string; userClient: any; connectionId: string },
): Promise<{ ok: true }> {
  const connection = await deps.loadConnectionForUser(
    input.connectionId,
    input.userId,
  );
  if (!connection) throw new ConnectError("forbidden", 403);
  if (!deps.composio) {
    await deps.recordCall({
      workspaceId: connection.workspaceId,
      connectionId: connection.id,
      connectorType: connection.connectorType,
      authStrategy: "composio_oauth",
      actionName: "revoke",
      source: "test",
    }, { status: "refused", errorCode: "connector_unavailable" });
    throw new ConnectError("connector_unavailable", 503);
  }

  if (connection.composioConnectedAccountId) {
    try {
      await deps.composio.deleteConnectedAccount(
        connection.composioConnectedAccountId,
      );
    } catch (error) {
      if (!(error instanceof ComposioError)) throw error;
      console.warn("[composio-connect] provider revoke failed");
    }
  }
  await deps.revokeRpc(input.userClient, connection.id);
  return { ok: true };
}
