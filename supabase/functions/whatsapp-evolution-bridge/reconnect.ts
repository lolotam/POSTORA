// Reconnect-in-place for a Direct QR connection: same account row, same Evolution
// instance name and webhook credential, fresh QR. The alternative -- create a new
// account -- would orphan the AI agent setup, store bindings and conversation history
// attached to the row this reuses.
import { EvolutionApiError, type EvolutionApi, type EvolutionEvent } from "../_shared/evolutionApi.ts";
import { extractQr, extractState } from "./qr.ts";

export class ReconnectError extends Error {
  constructor(message: string, public readonly status: 404 | 409 | 502) {
    super(message);
    this.name = "ReconnectError";
  }
}

export interface ReconnectDeps {
  findAccount(userId: string, id: string): Promise<{ id: string; platform_user_id: string; connection_mode: string | null } | null>;
  findInstance(id: string): Promise<{ instance_name: string; jwt_key: string } | null>;
  api: Pick<EvolutionApi, "fetchInstance" | "connectionState" | "createInstance" | "connect" | "logout" | "setWebhook">;
  webhook: { url: string; events: EvolutionEvent[] };
  saveQr(id: string, qr: string | null, state: string | null): Promise<void>;
  /** Clears the durable number_mismatch flag once the reconnect is provably working. */
  clearMismatch(id: string): Promise<void>;
}

export async function reconnectQr(deps: ReconnectDeps, userId: string, socialAccountId: string) {
  const account = await deps.findAccount(userId, socialAccountId);
  if (!account) throw new ReconnectError("WhatsApp Direct QR account not found", 404);
  // Placeholder ids never finished pairing and retired rows were merged away; neither
  // has a live session to reconnect, so the user is sent to the new-connection flow.
  if (account.connection_mode !== "evolution_qr"
    || account.platform_user_id.startsWith("pending_")
    || account.platform_user_id.startsWith("retired_")) {
    throw new ReconnectError("This connection can't be reconnected; connect a new one instead", 409);
  }
  const instance = await deps.findInstance(socialAccountId);
  // Without the stored jwt_key the recreated instance would be unreachable by our webhook.
  if (!instance) throw new ReconnectError("reconnect_unavailable", 409);
  const name = instance.instance_name;
  try {
    // The remote instance may be gone (Evolution restart, manual delete). Both shapes of
    // "missing" -- an empty list and a 404 -- mean recreate; anything else is a failure.
    let exists: boolean;
    try {
      exists = (await deps.api.fetchInstance(name)) !== null;
    } catch (error) {
      if (error instanceof EvolutionApiError && error.status === 404) exists = false;
      else throw error;
    }
    if (!exists) {
      await deps.api.createInstance({
        instanceName: name,
        webhook: { url: deps.webhook.url, headers: { jwt_key: instance.jwt_key }, events: deps.webhook.events },
      });
    } else if (extractState(await deps.api.connectionState(name)) === "open") {
      // A still-linked session must be logged out before connect, or Evolution answers
      // with the live session instead of a fresh QR.
      await deps.api.logout(name);
    }
    // Re-asserted on every reconnect: the stored credential is the single source of truth
    // for which webhook receives this instance's events.
    await deps.api.setWebhook(name, { url: deps.webhook.url, headers: { jwt_key: instance.jwt_key }, events: deps.webhook.events });
    const connection = await deps.api.connect(name);
    const qr = extractQr(connection);
    const state = extractState(connection);
    await deps.clearMismatch(socialAccountId);
    await deps.saveQr(socialAccountId, qr, state);
    return { success: true as const, social_account_id: socialAccountId, qr, state };
  } catch (error) {
    if (error instanceof ReconnectError) throw error;
    // The Evolution error text can carry internal hosts; only the account id goes out.
    console.error(`[whatsapp-evolution-bridge] reconnect failed for ${socialAccountId}`);
    throw new ReconnectError("reconnect_failed", 502);
  }
}
