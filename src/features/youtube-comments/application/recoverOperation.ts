import type { YouTubeCommentsGateway } from "./ports";
import { YouTubeCommentsError, isRebindReason } from "../domain/errors";
import { clearPendingOperation, type PendingStage4Operation } from "../domain/operationIdentity";
import type { Stage4OperationStatusPayload } from "../domain/types";

/** What reading one pending operation's receipt produced. */
export interface RecoveryResult {
  operation: PendingStage4Operation;
  /** The receipt, or null when it can no longer be read OR cannot be read right now. */
  status: Stage4OperationStatusPayload | null;
  /** True when the local identity was cleared because the outcome is settled or unreadable for good. */
  settled: boolean;
  /** True when the read failed for a TEMPORARY reason: the identity is kept and the owner can check again. */
  unavailable: boolean;
}

/**
 * Read the receipt of one pending operation.
 *
 * Only a definite answer clears the local identity: a confirmed or refused
 * receipt, or `not_found` / `binding_changed` (the receipt belongs to a
 * binding that no longer exists, so it can never be read again). A network
 * drop, a 429, a 5xx or any other temporary failure keeps the identity and
 * reports the status as unavailable — it must never be shown as "reconnect".
 */
export async function recoverOperation(
  gateway: YouTubeCommentsGateway,
  userId: string,
  accountId: string,
  operation: PendingStage4Operation,
): Promise<RecoveryResult> {
  try {
    const status = await gateway.operationStatus({ accountId, operationId: operation.operationId });
    const settled = status.state === "confirmed" || status.state === "refused";
    if (settled) clearPendingOperation(userId, operation.operationId);
    return { operation, status, settled, unavailable: false };
  } catch (error) {
    if (error instanceof YouTubeCommentsError && isRebindReason(error.code)) {
      clearPendingOperation(userId, operation.operationId);
      return { operation, status: null, settled: true, unavailable: false };
    }
    return { operation, status: null, settled: false, unavailable: true };
  }
}
