import { describe, expect, it } from "vitest";
import type { AuthChangeEvent } from "@supabase/supabase-js";
import { shouldClearQueryCacheOnAuthTransition } from "@/hooks/useAuthQueryCacheSync";

// This table is the whole point of the predicate: a naive implementation
// passes the SIGNED_OUT row and still refetch-storms on every token refresh
// or tab refocus. Supabase emits SIGNED_IN on refocus and TOKEN_REFRESHED on
// routine background refreshes — neither may clear the cache for the same user.
describe("shouldClearQueryCacheOnAuthTransition", () => {
  it.each<{
    event: AuthChangeEvent;
    previous: string | null | undefined;
    next: string | null;
    expected: boolean;
  }>([
    { event: "TOKEN_REFRESHED", previous: "user-a", next: "user-a", expected: false },
    { event: "TOKEN_REFRESHED", previous: "user-a", next: "user-b", expected: false },
    { event: "INITIAL_SESSION", previous: "user-a", next: "user-a", expected: false },
    { event: "INITIAL_SESSION", previous: "user-a", next: "user-b", expected: false },
    { event: "SIGNED_IN", previous: "user-a", next: "user-b", expected: true },
    { event: "SIGNED_IN", previous: "user-a", next: "user-a", expected: false },
    { event: "SIGNED_OUT", previous: "user-a", next: null, expected: true },
    { event: "SIGNED_OUT", previous: null, next: null, expected: false },
    { event: "USER_UPDATED", previous: "user-a", next: "user-a", expected: false },
    { event: "SIGNED_IN", previous: undefined, next: "user-a", expected: false },
    { event: "SIGNED_OUT", previous: undefined, next: null, expected: false },
  ])(
    "$event previous=$previous next=$next clears=$expected",
    ({ event, previous, next, expected }) => {
      expect(shouldClearQueryCacheOnAuthTransition(event, previous, next)).toBe(expected);
    },
  );
});
