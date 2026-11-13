// The Evolution state read, split out of the entrypoint so the rule "a read that cannot be
// answered is a failure, not a state" is testable without an Evolution server.

import { extractState } from "../whatsapp-evolution-bridge/qr.ts";

export interface ConnectionStateApi {
  connectionState(instanceName: string): Promise<unknown>;
}

/**
 * The live state of one instance.
 *
 * A read that cannot be answered is NOT a state and must not become one: it raises, so
 * the caller treats the account as a failure. Answering null instead would record the
 * account as polled and skip it, and an account the watcher could not reach would then
 * go unpolled until the next freshness window, with its outage neither alerted nor
 * recorded.
 */
export async function readConnectionState(
  api: ConnectionStateApi,
  instanceName: string,
): Promise<string | null> {
  return extractState(await api.connectionState(instanceName));
}
