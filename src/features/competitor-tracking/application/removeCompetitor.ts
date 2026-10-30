/**
 * The remove lifecycle of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The owner's "stop tracking this" gesture.
 *
 * WHY A REMOVAL IS NEVER A DELETE
 *
 *   The snapshots of a removed competitor are the evidence the owner
 *   kept, and they outlive the removal by ninety days. The owner RPC
 *   therefore flips `is_active` and stamps `removed_at`; it never
 *   deletes a row. This module asks for the soft removal and reports
 *   what the database answered.
 *
 * WHY A LOST WRITE IS NEVER REPLAYED
 *
 *   A removal whose response was lost is INDETERMINATE. The row may be
 *   removed or it may not be. The only honest next step is a read of
 *   the owner's own list, and this module never turns an unknown into a
 *   removal.
 */

import type { CompetitorReportQuota } from "../domain/contracts";
import {
  CompetitorTrackingError,
  isIndeterminateErrorCode,
} from "../domain/errors";
import type { CompetitorSetActiveResult, CompetitorTrackingGateway } from "./ports";

/** The dependencies of the remove lifecycle. */
export type RemoveCompetitorDeps = {
  readonly gateway: CompetitorTrackingGateway;
};

/** What the owner asked for. */
export type RemoveCompetitorInput = {
  readonly watchlistId: string;
};

/** The result of the remove lifecycle. */
export type RemoveCompetitorResult =
  | {
      readonly outcome: "removed";
      readonly watchlistId: string;
      readonly username: string;
      readonly removedAt: string | null;
      readonly quota: CompetitorReportQuota | null;
    }
  | {
      readonly outcome: "failure";
      readonly error: CompetitorTrackingError;
    }
  | {
      readonly outcome: "indeterminate";
      readonly error: CompetitorTrackingError;
    };

function toTrackingError(error: unknown): CompetitorTrackingError {
  if (error instanceof CompetitorTrackingError) return error;
  return new CompetitorTrackingError(
    "MUTATION_UNAVAILABLE",
    "the competitor could not be removed",
  );
}

/**
 * Removes one tracked competitor, softly.
 *
 * The label is deliberately not sent: a null label preserves the stored
 * label, and this feature has no convention for clearing one.
 */
export async function removeCompetitor(
  deps: RemoveCompetitorDeps,
  input: RemoveCompetitorInput,
): Promise<RemoveCompetitorResult> {
  let updated: CompetitorSetActiveResult;
  try {
    updated = await deps.gateway.setActive({
      watchlistId: input.watchlistId,
      isActive: false,
      label: null,
    });
  } catch (error) {
    const failure = toTrackingError(error);
    return isIndeterminateErrorCode(failure.code)
      ? { outcome: "indeterminate", error: failure }
      : { outcome: "failure", error: failure };
  }

  return {
    outcome: "removed",
    watchlistId: updated.watchlistId,
    username: updated.username,
    removedAt: updated.removedAt,
    quota: updated.quota,
  };
}
