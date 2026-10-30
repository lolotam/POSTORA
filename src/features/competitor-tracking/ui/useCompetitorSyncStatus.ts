/**
 * The collection-status polling of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The bounded poll of ONE tracked competitor's collection state, and
 *   the rules that end it.
 *
 * WHY THE POLL IS BOUNDED
 *
 *   An accepted enqueue means QUEUED. It does not mean the snapshot was
 *   collected, and it does not mean it ever will be. The poll therefore
 *   runs at most twelve times, five seconds apart, and then says
 *   "Still queued; check status" (spec §4).
 *
 * WHY THE POLL NEVER SCHEDULES WORK
 *
 *   Reading a status is a read. It never enqueues, never calls a
 *   provider and never re-queues a job. The only write in this feature
 *   is the explicit "Retry collection" gesture.
 *
 * WHY IT STOPS ON AN AUTH CHANGE
 *
 *   The poll belongs to the owner who started it. When the
 *   authenticated identity changes, the poll is abandoned instead of
 *   being carried into the next owner's session.
 */

import { useEffect, useRef } from "react";
import { useQuery } from "@tanstack/react-query";

import type {
  CompetitorCollectionStatus,
  CompetitorTrackingGateway,
} from "../application/ports";
import { CompetitorTrackingError, isCompetitorTrackingError } from "../domain/errors";
import { competitorTrackingKeys } from "./useCompetitorTracking";

/** The gap between two polls of the same target. */
export const COMPETITOR_SYNC_POLL_INTERVAL_MS = 5_000;

/** The number of polls one target is allowed. */
export const COMPETITOR_SYNC_MAX_POLLS = 12;

/**
 * The job states that end the poll.
 *
 * A completed, unavailable or failed job is a FINAL answer: polling it
 * again cannot change it. A job in `retry` is DEFERRED: the collector
 * scheduled the next attempt, and the screen shows the server's own
 * retry time instead of guessing one.
 */
const TERMINAL_STATUSES = new Set(["completed", "unavailable", "error"]);

const DEFERRED_STATUSES = new Set(["retry"]);

/** How the poll ended. */
export type CompetitorSyncState =
  /** Nothing is being polled. */
  | "idle"
  /** The poll is running. */
  | "polling"
  /** The job reached a final state. */
  | "settled"
  /** The collector deferred the work until a known time. */
  | "deferred"
  /** The poll budget ran out before the job finished. */
  | "exhausted"
  /** The status could not be read. */
  | "failed";

export type UseCompetitorSyncStatusOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
  watchlistId: string | null;
  enabled?: boolean;
  /** Overridable so the bound can be exercised without waiting five minutes. */
  intervalMs?: number;
  /** Overridable so the bound can be exercised without waiting a minute. */
  maxPolls?: number;
};

export type CompetitorSyncStatusResult = {
  state: CompetitorSyncState;
  collection: CompetitorCollectionStatus | null;
  /** The number of status reads this poll performed. */
  polls: number;
  /** The server's own retry time, when it published one. */
  retryAt: string | null;
  error: CompetitorTrackingError | null;
};

function toTrackingError(error: unknown): CompetitorTrackingError | null {
  if (error === null || error === undefined) return null;
  if (isCompetitorTrackingError(error)) return error;
  if (error instanceof Error && error.name === "AbortError") return null;
  return new CompetitorTrackingError(
    "STATUS_UNAVAILABLE",
    "the collection status could not be read",
  );
}

/**
 * Polls one target's collection state until it settles.
 *
 * The poll is one React Query with a computed interval: the interval
 * function decides after every read whether another read is due, which
 * is where the terminal, deferred and budget rules live.
 */
export function useCompetitorSyncStatus({
  gateway,
  userId,
  watchlistId,
  enabled = true,
  intervalMs = COMPETITOR_SYNC_POLL_INTERVAL_MS,
  maxPolls = COMPETITOR_SYNC_MAX_POLLS,
}: UseCompetitorSyncStatusOptions): CompetitorSyncStatusResult {
  const ownerKey = userId ?? "anonymous";
  const targetKey = watchlistId ?? "none";
  const active = enabled && Boolean(userId) && Boolean(watchlistId);

  // The poll counter belongs to ONE target. A different target starts
  // its own budget, so the counter is reset inside the read that
  // notices the change rather than in an effect that could run after
  // the first read.
  const pollKeyRef = useRef<string | null>(null);
  const pollsRef = useRef(0);

  // The poll belongs to the session that started it. When the
  // authenticated identity changes under it, the poll is abandoned
  // instead of being carried into the next owner's session.
  const ownerRef = useRef<string | null>(userId);
  const authChangedRef = useRef(false);
  useEffect(() => {
    if (ownerRef.current !== userId) {
      ownerRef.current = userId;
      authChangedRef.current = true;
    }
  }, [userId]);

  const query = useQuery({
    queryKey: competitorTrackingKeys.status(ownerKey, targetKey),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      if (pollKeyRef.current !== targetKey) {
        pollKeyRef.current = targetKey;
        pollsRef.current = 0;
        // A new target is a new poll: it may be armed again.
        authChangedRef.current = false;
      }
      pollsRef.current += 1;
      return await gateway.status({ watchlistId: targetKey }, { signal });
    },
    enabled: active,
    staleTime: 0,
    // A failed status read is shown with the error. Repeating it in the
    // background would be the endless retry the spec forbids.
    retry: false,
    refetchInterval: (current) => {
      const data = current.state.data;
      if (current.state.status === "error") return false;
      if (data && TERMINAL_STATUSES.has(data.status)) return false;
      if (data && DEFERRED_STATUSES.has(data.status)) return false;
      if (authChangedRef.current) return false;
      // Every read counts as one poll. The budget ends the poll BEFORE
      // a thirteenth read happens.
      if (pollsRef.current >= maxPolls) return false;
      return intervalMs;
    },
  });

  const collection = query.data ?? null;
  const error = toTrackingError(query.error);
  const polls = pollsRef.current;

  let state: CompetitorSyncState;
  if (!active) {
    state = "idle";
  } else if (error !== null) {
    state = "failed";
  } else if (collection && TERMINAL_STATUSES.has(collection.status)) {
    state = "settled";
  } else if (collection && DEFERRED_STATUSES.has(collection.status)) {
    state = "deferred";
  } else if (polls >= maxPolls) {
    state = "exhausted";
  } else {
    state = "polling";
  }

  return {
    state,
    collection,
    polls,
    retryAt: collection?.nextRetryAt ?? null,
    error,
  };
}
