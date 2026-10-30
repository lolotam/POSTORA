/**
 * The reactivate lifecycle of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The owner's "track it again" gesture for an entry that was removed
 *   but is still retained.
 *
 * THE ORDER IS FIXED
 *
 *     1. activate the SAME entry (the owner RPC clears the removal
 *        marker, keeps the history and checks the quota)
 *     2. enqueue the collection ONCE, without the force flag
 *
 *   The identity is preserved on purpose: while the row exists, the
 *   reactivated competitor is the SAME competitor with the same history,
 *   not a new one. After the retention job has physically removed the
 *   row, tracking the handle again creates a NEW identity and this
 *   feature promises nothing about the old history.
 *
 * WHY A LOST WRITE IS NEVER REPLAYED
 *
 *   A reactivation whose response was lost is INDETERMINATE, exactly
 *   like a lost removal. The owner reconciles by reading.
 */

import type { CompetitorReportQuota } from "../domain/contracts";
import {
  CompetitorTrackingError,
  isIndeterminateErrorCode,
} from "../domain/errors";
import { isValidCompetitorLabel } from "../domain/handle";
import type {
  CompetitorEnqueueResult,
  CompetitorSetActiveResult,
  CompetitorTrackingGateway,
} from "./ports";

/** The dependencies of the reactivate lifecycle. */
export type ReactivateCompetitorDeps = {
  readonly gateway: CompetitorTrackingGateway;
};

/** What the owner asked for. */
export type ReactivateCompetitorInput = {
  readonly watchlistId: string;
  readonly label?: string | null;
};

/** The result of the reactivate lifecycle. */
export type ReactivateCompetitorResult =
  | {
      readonly outcome: "reactivated_and_queued";
      readonly watchlistId: string;
      readonly username: string;
      readonly quota: CompetitorReportQuota | null;
    }
  | {
      readonly outcome: "reactivated_enqueue_unconfirmed";
      readonly watchlistId: string;
      readonly username: string;
      readonly quota: CompetitorReportQuota | null;
      readonly reason: "throttled" | "refused" | "indeterminate";
      readonly error: CompetitorTrackingError;
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
    "the competitor could not be reactivated",
  );
}

/**
 * Reactivates one removed competitor and asks for a collection.
 */
export async function reactivateCompetitor(
  deps: ReactivateCompetitorDeps,
  input: ReactivateCompetitorInput,
): Promise<ReactivateCompetitorResult> {
  if (!isValidCompetitorLabel(input.label)) {
    return {
      outcome: "failure",
      error: new CompetitorTrackingError(
        "LABEL_INVALID",
        "the label is longer than the database accepts",
      ),
    };
  }

  let updated: CompetitorSetActiveResult;
  try {
    updated = await deps.gateway.setActive({
      watchlistId: input.watchlistId,
      isActive: true,
      label: input.label ?? null,
    });
  } catch (error) {
    const failure = toTrackingError(error);
    return isIndeterminateErrorCode(failure.code)
      ? { outcome: "indeterminate", error: failure }
      : { outcome: "failure", error: failure };
  }

  let enqueued: CompetitorEnqueueResult;
  try {
    enqueued = await deps.gateway.enqueue({
      watchlistId: updated.watchlistId,
      force: false,
    });
  } catch (error) {
    const failure = toTrackingError(error);
    // The entry is active again. The collection is not confirmed, and
    // the enqueue is NEVER replayed automatically.
    return {
      outcome: "reactivated_enqueue_unconfirmed",
      watchlistId: updated.watchlistId,
      username: updated.username,
      quota: updated.quota,
      reason: isIndeterminateErrorCode(failure.code) ? "indeterminate" : "refused",
      error: failure,
    };
  }

  if (enqueued.outcome !== "accepted") {
    return {
      outcome: "reactivated_enqueue_unconfirmed",
      watchlistId: updated.watchlistId,
      username: updated.username,
      quota: updated.quota,
      reason: "throttled",
      error: new CompetitorTrackingError(
        "THROTTLED",
        "the collection was deferred by the server",
        { retryAfterSeconds: enqueued.retryAfterSeconds },
      ),
    };
  }

  return {
    outcome: "reactivated_and_queued",
    watchlistId: updated.watchlistId,
    username: updated.username,
    quota: updated.quota,
  };
}
