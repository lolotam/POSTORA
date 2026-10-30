/**
 * The track lifecycle of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The orchestration of ONE owner gesture: "track this handle".
 *
 *   The order is fixed and it is the whole point of this module:
 *
 *     1. validate the handle and the label (no I/O, no slot consumed)
 *     2. save the entry through the owner RPC
 *     3. enqueue the collection ONCE, without the force flag
 *
 * WHY THE ENQUEUE IS SEPARATE FROM THE SAVE
 *
 *   The owner RPC saves a row; the collector works on it. They are
 *   different systems with different failure modes, and the difference
 *   is what the owner is told.
 *
 *     saved_and_queued            the row exists and the work was accepted
 *     saved_enqueue_unconfirmed   the row exists, the work was NOT confirmed
 *     already_tracked             the row existed and is active already
 *     failure                     the row was NOT saved
 *     indeterminate               the row may or may not have been saved
 *
 *   "saved_enqueue_unconfirmed" is NOT a failure of the tracking: the
 *   row is saved, the history is intact, and the owner may retry the
 *   collection explicitly once the reason is known. The saved row is
 *   never rolled back and never saved twice.
 *
 * WHY A LOST WRITE IS NEVER REPLAYED
 *
 *   When the save or the enqueue cannot be observed, the honest answer
 *   is "could not confirm". A blind retry would either double the slot
 *   consumption or enqueue the same work twice, and neither is
 *   observable afterwards. The owner reconciles by reading instead.
 */

import type { CompetitorReportQuota } from "../domain/contracts";
import {
  CompetitorTrackingError,
  isIndeterminateErrorCode,
} from "../domain/errors";
import {
  isValidCompetitorLabel,
  validateInstagramHandle,
} from "../domain/handle";
import type {
  CompetitorAddResult,
  CompetitorEnqueueResult,
  CompetitorTrackingGateway,
} from "./ports";

/** The dependencies of the track lifecycle. */
export type TrackCompetitorDeps = {
  readonly gateway: CompetitorTrackingGateway;
};

/** What the owner asked for. */
export type TrackCompetitorInput = {
  readonly username: string;
  readonly label?: string | null;
};

/** Why the collection could not be confirmed. */
export type CompetitorEnqueueUnconfirmedReason =
  /** The server deferred the work and published a retry time. */
  | "throttled"
  /** The server refused the work for a known reason. */
  | "refused"
  /** The outcome of the enqueue could not be observed. */
  | "indeterminate";

/**
 * The result of the track lifecycle.
 *
 * It is a discriminated union on `outcome`, so a caller cannot read a
 * watchlist id off a failed attempt.
 */
export type TrackCompetitorResult =
  | {
      readonly outcome: "saved_and_queued";
      readonly watchlistId: string;
      readonly username: string;
      readonly quota: CompetitorReportQuota | null;
    }
  | {
      readonly outcome: "saved_enqueue_unconfirmed";
      readonly watchlistId: string;
      readonly username: string;
      readonly quota: CompetitorReportQuota | null;
      readonly reason: CompetitorEnqueueUnconfirmedReason;
      readonly error: CompetitorTrackingError;
    }
  | {
      readonly outcome: "already_tracked";
      readonly watchlistId: string;
      readonly username: string;
      /** The already-tracked reply carries no quota, and that is correct. */
      readonly quota: null;
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
    "the competitor could not be tracked",
  );
}

/**
 * Tracks an Instagram handle for the owner.
 */
export async function trackCompetitor(
  deps: TrackCompetitorDeps,
  input: TrackCompetitorInput,
): Promise<TrackCompetitorResult> {
  const validation = validateInstagramHandle(input.username);
  if (validation.outcome !== "valid") {
    return {
      outcome: "failure",
      error: new CompetitorTrackingError(
        "INVALID_HANDLE",
        validation.reason === "empty"
          ? "the handle is empty"
          : "the handle has a shape Instagram never issues",
      ),
    };
  }

  if (!isValidCompetitorLabel(input.label)) {
    return {
      outcome: "failure",
      error: new CompetitorTrackingError(
        "LABEL_INVALID",
        "the label is longer than the database accepts",
      ),
    };
  }

  let saved: CompetitorAddResult;
  try {
    saved = await deps.gateway.add({
      username: validation.handle,
      label: input.label ?? null,
    });
  } catch (error) {
    const failure = toTrackingError(error);
    return isIndeterminateErrorCode(failure.code)
      ? { outcome: "indeterminate", error: failure }
      : { outcome: "failure", error: failure };
  }

  if (saved.alreadyTracked) {
    // The handle is already tracked and active. It consumes no slot, it
    // resets no status, and it is NOT collected again: the owner asked
    // to track it, not to force a refresh.
    return {
      outcome: "already_tracked",
      watchlistId: saved.watchlistId,
      username: saved.username,
      quota: null,
    };
  }

  let enqueued: CompetitorEnqueueResult;
  try {
    enqueued = await deps.gateway.enqueue({
      watchlistId: saved.watchlistId,
      force: false,
    });
  } catch (error) {
    const failure = toTrackingError(error);
    // The row is saved. The work is not confirmed. The row is preserved
    // and the enqueue is NEVER replayed automatically.
    return {
      outcome: "saved_enqueue_unconfirmed",
      watchlistId: saved.watchlistId,
      username: saved.username,
      quota: saved.quota,
      reason: isIndeterminateErrorCode(failure.code) ? "indeterminate" : "refused",
      error: failure,
    };
  }

  if (enqueued.outcome !== "accepted") {
    return {
      outcome: "saved_enqueue_unconfirmed",
      watchlistId: saved.watchlistId,
      username: saved.username,
      quota: saved.quota,
      reason: "throttled",
      error: new CompetitorTrackingError(
        "THROTTLED",
        "the collection was deferred by the server",
        { retryAfterSeconds: enqueued.retryAfterSeconds },
      ),
    };
  }

  return {
    outcome: "saved_and_queued",
    watchlistId: saved.watchlistId,
    username: saved.username,
    quota: saved.quota,
  };
}
