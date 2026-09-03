import {
  COMPOSIO_CALLBACK_ACCOUNT_PARAMS,
  COMPOSIO_CALLBACK_STATUS_PARAM,
  type ComposioConnectedAccount,
  ComposioError,
} from "../_shared/composioClient.ts";
import { verifyConnectState } from "../_shared/composioState.ts";
import {
  accountRefusal,
  activateConnection,
  findFreshActiveAccount,
  markFailed,
} from "./activation.ts";
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
  await markFailed(deps, connection, code);
  return redirect(deps, code, connection);
}

type AccountResolution =
  | { ok: true; account: ComposioConnectedAccount }
  | { ok: false; code: "connection_not_found" | "connector_unavailable" };

/**
 * Composio's docs show two spellings of the id parameter and a `status`
 * parameter; a failed authorisation is refused before any provider call. When
 * no id arrives at all, the account is the one the listing says this flow made.
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
  const accountId = COMPOSIO_CALLBACK_ACCOUNT_PARAMS
    .map((name) => url.searchParams.get(name))
    .find((value): value is string => Boolean(value));
  try {
    const account = accountId
      ? await deps.composio.getConnectedAccount(accountId)
      : await findFreshActiveAccount(deps, connection);
    return account
      ? { ok: true, account }
      : { ok: false, code: "connection_not_found" };
  } catch (error) {
    if (!(error instanceof ComposioError)) throw error;
    return { ok: false, code: "connector_unavailable" };
  }
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
    return redirect(deps, "invalid_state", connection ?? undefined);
  }

  const resolved = await resolveConnectedAccount(deps, connection, url);
  if (!resolved.ok) return await refuse(deps, connection, resolved.code);
  const refusal = accountRefusal(resolved.account, connection);
  if (refusal) return await refuse(deps, connection, refusal);

  const outcome = await activateConnection(
    deps,
    connection,
    { nonce: state.nonce, socialProfileId: state.socialProfileId },
    resolved.account,
  );
  return redirect(deps, outcome, connection);
}
