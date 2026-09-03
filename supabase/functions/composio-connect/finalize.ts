// The poll the app relies on to complete a connection. Composio's hosted Link
// page ends on "Successfully connected — you can close this window" and never
// sends the browser back (observed 2026-09-03), so the app asks us, every few
// seconds, whether Composio has activated the account this row started.
import { ComposioError } from "../_shared/composioClient.ts";
import { COMPOSIO_CONNECT_STATE_TTL_SECONDS } from "../_shared/composioInitiate.ts";
import {
  accountRefusal,
  activateConnection,
  findFreshActiveAccount,
  markFailed,
} from "./activation.ts";
import type { ComposioConnectDependencies } from "./dependencies.ts";
import { ConnectError } from "./handler.ts";

export type FinalizeResult =
  | { status: "active" }
  | { status: "pending" }
  | { status: "failed"; failure_code: string };

const failed = (failure_code: string): FinalizeResult => ({ status: "failed", failure_code });

/**
 * Idempotent: an active row answers `active` without touching Composio; a row
 * still waiting answers `pending` until the listing shows the account, and is
 * expired here on the same TTL the signed state carries, so a poll that
 * outlives the OAuth window fails closed instead of adopting a later account.
 */
export async function finalizeConnection(
  deps: ComposioConnectDependencies,
  input: { userId: string; connectionId: string; socialProfileId: string | null },
): Promise<FinalizeResult> {
  const owned = await deps.loadConnectionForUser(input.connectionId, input.userId);
  if (!owned) throw new ConnectError("forbidden", 403);
  if (owned.status === "active") return { status: "active" };
  if (owned.status !== "initiated") return failed(owned.failureCode ?? owned.status);

  const pending = await deps.loadPendingConnection(input.connectionId, owned.workspaceId);
  if (!pending || !pending.stateNonce) return failed("invalid_state");
  const expiresAt = Date.parse(pending.createdAt) + COMPOSIO_CONNECT_STATE_TTL_SECONDS * 1_000;
  if (deps.now() >= expiresAt) {
    await markFailed(deps, pending, "expired");
    return failed("expired");
  }

  let account;
  try {
    account = await findFreshActiveAccount(deps, pending);
  } catch (error) {
    // A Composio hiccup mid-poll is not a verdict on the row; the next poll asks again.
    if (!(error instanceof ComposioError)) throw error;
    return { status: "pending" };
  }
  if (!account) return { status: "pending" };
  const refusal = accountRefusal(account, pending);
  if (refusal) {
    await markFailed(deps, pending, refusal);
    return failed(refusal);
  }
  const outcome = await activateConnection(
    deps,
    pending,
    { nonce: pending.stateNonce, socialProfileId: input.socialProfileId },
    account,
  );
  return outcome === "ok" ? { status: "active" } : failed(outcome);
}
