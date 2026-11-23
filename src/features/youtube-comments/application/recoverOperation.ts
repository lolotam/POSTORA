import type { YouTubeCommentsGateway } from "./ports";
import { YouTubeCommentsError, isRebindReason } from "../domain/errors";
import { clearPendingOperation, type PendingStage4Operation } from "../domain/operationIdentity";
import type { Stage4OperationStatusPayload } from "../domain/types";

/** What reading one pending operation's receipt produced. */
export interface RecoveryResult {
  operation: PendingStage4Operation;
  /** The receipt, or null when it can no longer be read OR cannot be read right now. */
  status: Stage4OperationStatusPayload | null;
  /** True when the outcome is definite (settled, or unreadable for good); the caller then clears the identity. */
  settled: boolean;
  /** True when the read failed for a TEMPORARY reason: the identity is kept and the owner can check again. */
  unavailable: boolean;
  /** True when the receipt is still claimed or dispatched: the write may yet land, so it is neither applied nor refused. */
  inFlight: boolean;
}

/**
 * How long after its submit a missing receipt can still be a pre-claim miss:
 * the handler may still be verifying the target or preparing a credential
 * before it records the claim, and an unclaimed row is closed after 120 s.
 */
export const PRE_CLAIM_GRACE_MS = 150_000;

/** A `not_found` this soon after the submit is not yet proof that the binding changed. */
export function isWithinPreClaimGrace(operation: PendingStage4Operation, now: number = Date.now()): boolean {
  return typeof operation.createdAt === "number" && now - operation.createdAt < PRE_CLAIM_GRACE_MS;
}

/**
 * Read the receipt of one pending operation. It reads only: it does NOT clear
 * the local identity. The caller clears it (clearSettled) once the result is
 * in state the current view can read, so a view that is torn down mid-read
 * (an account or mode switch, a StrictMode remount) cannot lose the only
 * reference to an operation whose outcome nobody has seen.
 *
 * `settled` marks a definite answer: a confirmed or refused receipt, or
 * `not_found` / `binding_changed` (the receipt belongs to a binding that no
 * longer exists, so it can never be read again). A network drop, a 429, a 5xx
 * or any other temporary failure is `unavailable` and keeps the identity —
 * it must never be shown as "reconnect".
 */
export async function recoverOperation(
  gateway: YouTubeCommentsGateway,
  accountId: string,
  operation: PendingStage4Operation,
): Promise<RecoveryResult> {
  try {
    const status = await gateway.operationStatus({ accountId, operationId: operation.operationId });
    const settled = status.state === "confirmed" || status.state === "refused";
    const inFlight = status.state === "claimed" || status.state === "dispatched";
    return { operation, status, settled, unavailable: false, inFlight };
  } catch (error) {
    if (error instanceof YouTubeCommentsError && isRebindReason(error.code)) {
      // A fresh submit's receipt may simply not exist yet: keep the identity
      // and let the owner check again. Only a binding change is final at once.
      if (error.code === "not_found" && isWithinPreClaimGrace(operation)) {
        return { operation, status: null, settled: false, unavailable: true, inFlight: false };
      }
      return { operation, status: null, settled: true, unavailable: false, inFlight: false };
    }
    return { operation, status: null, settled: false, unavailable: true, inFlight: false };
  }
}

/** Forget the identities whose outcome has just been published to the view. */
export function clearSettled(userId: string, results: RecoveryResult[]): void {
  for (const result of results) {
    if (result.settled) clearPendingOperation(userId, result.operation.operationId);
  }
}
