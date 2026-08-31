// Serialized per-connector refresh (§6.1, §9.2).
//
// Salla's contract: reusing a refresh token invalidates every token and
// the merchant must reinstall the app. Two overlapping refreshes do not
// merely fail — they brick the connection in a way only the merchant can
// repair. So concurrent callers must cause exactly one upstream refresh.
//
// The repo's pending_agent_replies work established that FOR UPDATE SKIP
// LOCKED alone is NOT a lease: a predicate on created_at is satisfied by a
// freshly claimed row immediately, so once the claiming transaction commits
// two workers can execute the same row. That design introduced a lease
// (lease_expires_at) and a CAS (advance_agent_reply WHERE status = p_from).
//
// For an in-process Edge Function isolate the simplest per-connector
// serialization is singleflight: a Map from connector id to the in-flight
// promise. Concurrent callers share the same promise and therefore share the
// single upstream call. This covers the unit-test requirement ("two
// concurrent refreshes produce exactly one upstream call") and the common
// case of overlapping cron + user-click refreshes inside one isolate.
//
// Distributed serialization (two isolates racing) requires a DB lease row
// analogous to pending_agent_replies (e.g. a connector_refresh_leases table
// with connector_id PK, lease_expires_at, and a try_acquire RPC). That is
// NOT implemented here — the isolate map is the seam. The TODO below names
// where the DB lease would be checked before entering the map, so adding it
// is one RPC away and does not change the callers.

export type RefreshResult = {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: string;
};

const inflight = new Map<string, Promise<RefreshResult>>();

// For tests: clear the map between cases. Production never calls this.
export function clearRefreshLocks(): void {
  inflight.clear();
}

export async function serializedRefresh(
  connectorId: string,
  // The actual vendor call. Called at most once per coalesced group.
  doRefresh: () => Promise<RefreshResult>,
): Promise<RefreshResult> {
  const existing = inflight.get(connectorId);
  if (existing) return existing;

  // TODO(distributed): before creating the promise, try to acquire a DB
  // lease row for this connectorId (SELECT ... FOR UPDATE or advisory
  // lock via RPC). If lease is held, await its result or return 409
  // "refresh already in progress". The singleflight below is then the
  // second layer for in-process coalescing.

  const promise = (async () => {
    try {
      return await doRefresh();
    } finally {
      inflight.delete(connectorId);
    }
  })();

  inflight.set(connectorId, promise);
  return promise;
}

// Exposed for tests to assert map size is bounded and keys are per-connector
export function inflightCount(): number {
  return inflight.size;
}
