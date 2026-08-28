import { useEffect, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { AuthChangeEvent } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";

/**
 * Decides whether the React Query cache must be cleared for an auth event.
 *
 * Supabase emits INITIAL_SESSION at startup, SIGNED_IN on tab refocus as well
 * as real sign-in, and TOKEN_REFRESHED on routine background refreshes, so
 * clearing on event name alone refetch-storms the whole app. The cache only
 * holds one user's data at a time, so it is cleared exactly when the
 * authenticated identity transitions — never when the same identity persists.
 *
 * `previousUserId === undefined` means "no event observed yet" and never clears.
 */
export function shouldClearQueryCacheOnAuthTransition(
  event: AuthChangeEvent,
  previousUserId: string | null | undefined,
  nextUserId: string | null,
): boolean {
  return (
    event !== "INITIAL_SESSION" &&
    previousUserId !== undefined &&
    previousUserId !== nextUserId &&
    (event === "SIGNED_IN" || event === "SIGNED_OUT")
  );
}

/**
 * Clears the query cache at the user-identity boundary. Mount once inside the
 * providers (like ActivityStoreScope) — the subscription fires before the
 * AuthProvider's own listener updates session state, so the cache is empty
 * before the first render of the new identity.
 */
export function useAuthQueryCacheSync() {
  const queryClient = useQueryClient();
  const lastUserIdRef = useRef<string | null | undefined>(undefined);

  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (event, session) => {
        const previousUserId = lastUserIdRef.current; // undefined = not yet initialised
        const nextUserId = session?.user?.id ?? null;
        if (shouldClearQueryCacheOnAuthTransition(event, previousUserId, nextUserId)) {
          queryClient.clear();
        }
        lastUserIdRef.current = nextUserId;
      },
    );
    return () => subscription.unsubscribe();
  }, [queryClient]);
}
