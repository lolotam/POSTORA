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
 * the caller counts the account as a failure. The caller still records the poll time,
 * which is what rotates a permanently failing row off the head of the queue. Answering
 * null here would classify the state as unknown instead of failed.
 */
export async function readConnectionState(
  api: ConnectionStateApi,
  instanceName: string,
): Promise<string | null> {
  return extractState(await api.connectionState(instanceName));
}
