/**
 * One sweep of WhatsApp Direct QR attempts that never paired.
 *
 * The popup removes its own attempt when the owner closes it, but a closed tab, a lost
 * connection or a failed request leaves the attempt behind. An attempt older than
 * PENDING_MAX_AGE_MS is past any scan the owner could still be doing, so it is removed here.
 * Each removal re-checks the row (pendingQrCleanup.ts), so an attempt that paired after it was
 * listed is kept.
 */

import { discardPendingQrAccount, type PendingQrCleanupPorts } from "../_shared/pendingQrCleanup.ts";

export const PENDING_MAX_AGE_MS = 30 * 60 * 1000;
/** Bounds one run well inside the worker limit; the next run picks up the rest. */
export const MAX_PER_RUN = 50;

export interface SweepPorts extends PendingQrCleanupPorts {
  /** Ids of never-paired Direct QR attempts created before `cutoffIso`, oldest first. */
  listStalePending(cutoffIso: string, limit: number): Promise<string[]>;
}

export interface SweepSummary {
  listed: number;
  deleted: number;
  /** Paired (or removed elsewhere) between the listing and the delete. */
  kept: number;
  evolution_errors: number;
  errors: number;
}

export async function runSweep(ports: SweepPorts, now: () => number = Date.now): Promise<SweepSummary> {
  const cutoff = new Date(now() - PENDING_MAX_AGE_MS).toISOString();
  const ids = await ports.listStalePending(cutoff, MAX_PER_RUN);
  const summary: SweepSummary = { listed: ids.length, deleted: 0, kept: 0, evolution_errors: 0, errors: 0 };

  for (const accountId of ids) {
    try {
      const result = await discardPendingQrAccount(ports, { accountId, ownerId: null, reason: "expired" });
      if (!result.deleted) summary.kept += 1;
      else {
        summary.deleted += 1;
        if (result.evolutionError) summary.evolution_errors += 1;
      }
    } catch (error) {
      // One row's failure must not strand the rest of the batch.
      summary.errors += 1;
      console.error("[sweep-pending-whatsapp-qr] discard failed:", error instanceof Error ? error.message : String(error));
    }
  }
  return summary;
}
