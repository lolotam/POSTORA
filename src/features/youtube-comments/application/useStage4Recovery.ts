import { useEffect, useState } from "react";
import { YouTubeCommentsGateway } from "./ports";
import { listPendingOperations, type PendingStage4Operation } from "../domain/operationIdentity";
import type { Stage4OperationStatusPayload } from "../domain/types";
import { clearSettled, recoverOperation, type RecoveryResult } from "./recoverOperation";

export interface StandaloneRecoveredOperation {
  operation: PendingStage4Operation;
  status: Stage4OperationStatusPayload | null;
  /** True when the status could not be read for a TEMPORARY reason; the identity is kept. */
  unavailable: boolean;
}

/**
 * Receipt recovery WITHOUT any capability, list or provider read.
 *
 * The approved rollback keeps `youtube_operation_status` reachable with every
 * capability off (spec 7.4 and plan 6), so the legacy inbox still owes the
 * owner the outcome of an operation started before the capability was turned
 * off or the channel was reconnected. This hook reads only the local receipt
 * status: one `operationStatus` call per pending operation, nothing else.
 */
export function useStage4Recovery(params: {
  userId: string;
  accountId: string;
  enabled: boolean;
  gateway: YouTubeCommentsGateway;
}) {
  const { userId, accountId, enabled } = params;
  const gateway = params.gateway;
  const [recovered, setRecovered] = useState<StandaloneRecoveredOperation[]>([]);

  useEffect(() => {
    if (!enabled || !accountId || !userId) return;
    let cancelled = false;
    setRecovered([]);
    const pending = listPendingOperations(userId, accountId);
    if (pending.length === 0) return;
    void (async () => {
      const results: RecoveryResult[] = [];
      for (const operation of pending) {
        results.push(await recoverOperation(gateway, accountId, operation));
      }
      // Cleared only once the result is in this view's state (see recoverOperation).
      if (!cancelled) {
        setRecovered(results.map((r) => ({ operation: r.operation, status: r.status, unavailable: r.unavailable })));
        clearSettled(userId, results);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, accountId, enabled, gateway]);

  return {
    recovered,
    clear: (operationId: string) => setRecovered((prev) => prev.filter((r) => r.operation.operationId !== operationId)),
    recheck: async (operationId: string) => {
      const current = recovered.find((r) => r.operation.operationId === operationId);
      if (!current) return;
      const next = await recoverOperation(gateway, accountId, current.operation);
      setRecovered((prev) => prev.map((r) => (
        r.operation.operationId === operationId ? { operation: next.operation, status: next.status, unavailable: next.unavailable } : r
      )));
      clearSettled(userId, [next]);
    },
  };
}
