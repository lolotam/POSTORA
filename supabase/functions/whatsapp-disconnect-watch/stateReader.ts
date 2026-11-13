// The Evolution state read, split out of the entrypoint so the rule "a read that cannot be
// answered is a failure, not a state" is testable without an Evolution server.

import { extractState } from "../whatsapp-evolution-bridge/qr.ts";
import { EvolutionApiError } from "../_shared/evolutionApi.ts";

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
  let payload: unknown;
  try {
    payload = await api.connectionState(instanceName);
  } catch (error) {
    const code = error instanceof EvolutionApiError ? "provider_error"
      : error instanceof Error && /timed out|aborted/i.test(error.message) ? "timeout"
      : "network_error";
    throw Object.assign(new Error("Evolution connection state unavailable"), { code });
  }
  const state = extractState(payload);
  if (!state?.trim()) {
    throw Object.assign(new Error("Invalid Evolution connection state response"), {
      code: "invalid_provider_response",
    });
  }
  return state;
}
