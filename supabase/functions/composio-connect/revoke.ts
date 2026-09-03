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
  // The provider delete is best effort (spec §6.4): a missing client is logged
  // like a failed delete, never a refusal. The kill switch (unset API key)
  // must not also stop an owner from revoking a connection whose tools are
  // still live — the RPC below is the source of truth for local state.
  if (!deps.composio) {
    console.warn("[composio-connect] provider revoke skipped: no client configured");
  } else if (connection.composioConnectedAccountId) {
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
