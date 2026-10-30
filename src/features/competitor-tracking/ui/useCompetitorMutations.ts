/**
 * The mutation hooks of the competitor tracking feature.
 *
 * WHAT THIS MODULE OWNS
 *
 *   The React Query bindings of the feature's four writes: track, retry
 *   the collection, remove and reactivate. Each one calls an
 *   APPLICATION use case - never the gateway directly - so the order of
 *   the calls stays in the application layer where it belongs.
 *
 * WHY NO MUTATION IS EVER RETRIED
 *
 *   A write whose outcome could not be observed is INDETERMINATE: the
 *   statement may or may not have committed. React Query's automatic
 *   retry would either consume a second slot or enqueue the same work
 *   twice, and neither is observable afterwards. The retry is therefore
 *   off, and the honest next step - a read - is offered to the owner
 *   instead (spec §4, §8).
 *
 * WHY THE INVALIDATION IS THE OWNER'S WHOLE SCOPE
 *
 *   A tracking change moves the entry between the active and the
 *   removed list, changes the quota, and changes what the Track control
 *   says about the handle. Those are ONE fact, so they are refreshed
 *   together: one invalidation of the owner's scope.
 */

import { useCallback, useMemo } from "react";
import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";

import { reactivateCompetitor } from "../application/reactivateCompetitor";
import type { ReactivateCompetitorResult } from "../application/reactivateCompetitor";
import { removeCompetitor } from "../application/removeCompetitor";
import type { RemoveCompetitorResult } from "../application/removeCompetitor";
import { trackCompetitor } from "../application/trackCompetitor";
import type { TrackCompetitorResult } from "../application/trackCompetitor";
import type { CompetitorTrackingGateway } from "../application/ports";
import { competitorTrackingKeys } from "./useCompetitorTracking";

/**
 * Refreshes everything the owner's tracking state is made of.
 *
 * The prefix is the owner's whole scope, so the list, the entries, the
 * quota and the tracked-identity lookup are invalidated TOGETHER.
 */
export function invalidateCompetitorTrackingScope(
  queryClient: QueryClient,
  userId: string | null,
): void {
  if (!userId) return;
  void queryClient.invalidateQueries({ queryKey: competitorTrackingKeys.all(userId) });
}

/* -------------------------------------------------------------------------- */
/* Track                                                                        */
/* -------------------------------------------------------------------------- */

export type UseTrackCompetitorOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
};

/**
 * Tracks one handle.
 *
 * The lifecycle - validate, save, enqueue once - lives in the
 * application layer. This hook only binds it to React Query and
 * refreshes the owner's scope afterwards.
 */
export function useTrackCompetitor({ gateway, userId }: UseTrackCompetitorOptions) {
  const queryClient = useQueryClient();

  return useMutation<TrackCompetitorResult, Error, { username: string; label?: string | null }>({
    mutationFn: async (input) =>
      await trackCompetitor({ gateway }, { username: input.username, label: input.label ?? null }),
    retry: false,
    onSuccess: () => {
      invalidateCompetitorTrackingScope(queryClient, userId);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Retry collection                                                             */
/* -------------------------------------------------------------------------- */

export type UseRetryCompetitorCollectionOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
};

/**
 * Asks the collector to work on one entry again.
 *
 * This is the ONLY place the force flag is used: a force is the
 * explicit "Retry collection" gesture, never the default.
 */
export function useRetryCompetitorCollection({
  gateway,
  userId,
}: UseRetryCompetitorCollectionOptions) {
  const queryClient = useQueryClient();

  return useMutation<
    Awaited<ReturnType<CompetitorTrackingGateway["enqueue"]>>,
    Error,
    string
  >({
    mutationFn: async (watchlistId: string) =>
      await gateway.enqueue({ watchlistId, force: true }),
    retry: false,
    onSuccess: () => {
      invalidateCompetitorTrackingScope(queryClient, userId);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Remove                                                                       */
/* -------------------------------------------------------------------------- */

export type UseRemoveCompetitorOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
};

/**
 * Removes one tracked competitor, softly.
 *
 * The history outlives the removal, so the entry moves to the removed
 * list instead of disappearing.
 */
export function useRemoveCompetitor({ gateway, userId }: UseRemoveCompetitorOptions) {
  const queryClient = useQueryClient();

  return useMutation<RemoveCompetitorResult, Error, string>({
    mutationFn: async (watchlistId: string) =>
      await removeCompetitor({ gateway }, { watchlistId }),
    retry: false,
    onSuccess: () => {
      invalidateCompetitorTrackingScope(queryClient, userId);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* Reactivate                                                                   */
/* -------------------------------------------------------------------------- */

export type UseReactivateCompetitorOptions = {
  gateway: CompetitorTrackingGateway;
  userId: string | null;
};

/**
 * Reactivates one removed competitor.
 *
 * The SAME entry is reused while it exists: the reactivated competitor
 * keeps its identity and its history.
 */
export function useReactivateCompetitor({ gateway, userId }: UseReactivateCompetitorOptions) {
  const queryClient = useQueryClient();

  return useMutation<ReactivateCompetitorResult, Error, string>({
    mutationFn: async (watchlistId: string) =>
      await reactivateCompetitor({ gateway }, { watchlistId }),
    retry: false,
    onSuccess: () => {
      invalidateCompetitorTrackingScope(queryClient, userId);
    },
  });
}

/* -------------------------------------------------------------------------- */
/* The pending guard                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The pending state of one write, scoped to ONE target.
 *
 * The screen is never blocked as a whole: a pending removal blocks
 * that row's button, and the other rows keep working. The guard is
 * therefore a function of the target, not a boolean.
 */
export function useCompetitorPendingGuard(mutation: {
  isPending: boolean;
  variables: string | undefined;
}): {
  isPending: (target: string) => boolean;
  pendingTarget: string | null;
} {
  const pendingTarget = useMemo(() => {
    if (!mutation.isPending || mutation.variables === undefined) return null;
    return mutation.variables;
  }, [mutation.isPending, mutation.variables]);

  const isPending = useCallback(
    (target: string) => pendingTarget !== null && pendingTarget === target,
    [pendingTarget],
  );

  return { isPending, pendingTarget };
}
