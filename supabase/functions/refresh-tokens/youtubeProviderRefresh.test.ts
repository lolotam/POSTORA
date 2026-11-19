import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  COMPOSIO_YOUTUBE_REAUTH_MESSAGE,
  probeYouTubeProvider,
  refreshNativeYouTubeAccount,
} from "./youtubeProviderRefresh.ts";
import type { YouTubeRefreshStore } from "../_shared/youtubeTokenRefresh.ts";

function adminFor(status: string) {
  const ledger: Record<string, unknown>[] = [];
  return {
    ledger,
    admin: {
      from(table: string) {
        if (table === "connector_call_logs") {
          return {
            insert: async (row: Record<string, unknown>) => {
              ledger.push(row);
              return { error: null };
            },
          };
        }
        if (table === "workspaces") {
          // resolveWorkspaceForCall's personal-workspace fallback.
          return {
            select() {
              return this;
            },
            eq() {
              return this;
            },
            async maybeSingle() {
              return { data: { id: "personal-workspace-1" }, error: null };
            },
          };
        }
        return {
          select() {
            return this;
          },
          eq() {
            return this;
          },
          async maybeSingle() {
            return {
              data: {
                id: "connection-1",
                workspace_id: "workspace-1",
                composio_connected_account_id: "ca-1",
                status,
              },
              error: null,
            };
          },
        };
      },
    },
  };
}

Deno.test("native YouTube remains on the native refresh path", async () => {
  let nativeCalls = 0;
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "native",
  }, {
    admin: state.admin,
    client: null,
    refreshNative: async () => {
      nativeCalls++;
      return "native-result";
    },
    markInactive: async () => {},
  });
  assertEquals(result, { provider: "native", result: "native-result" });
  assertEquals(nativeCalls, 1);
});

Deno.test("Composio YouTube never refreshes Google and marks non-ACTIVE accounts", async () => {
  let nativeCalls = 0;
  let inactiveCalls = 0;
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "composio",
    connection_id: "connection-1",
    workspace_id: "workspace-1",
  }, {
    admin: state.admin,
    client: {
      getConnectedAccount: async () => ({ status: "INACTIVE" }),
    } as never,
    refreshNative: async () => {
      nativeCalls++;
      return null;
    },
    markInactive: async () => {
      inactiveCalls++;
    },
  });
  assertEquals(result, { provider: "composio", active: false });
  assertEquals(nativeCalls, 0);
  assertEquals(inactiveCalls, 1);
  assertEquals(state.ledger.at(-1)?.source, "test");
});

// connector_call_logs.workspace_id is a NOT NULL uuid: a null account workspace
// must resolve to the owner's personal workspace, never the empty string that
// made every probe's ledger insert throw.
Deno.test("a null account workspace is ledgered against the owner's personal workspace", async () => {
  const state = adminFor("active");
  const result = await probeYouTubeProvider({
    id: "account-1",
    user_id: "owner-1",
    auth_provider: "composio",
    connection_id: "connection-1",
    workspace_id: null,
  }, {
    admin: state.admin,
    client: {
      getConnectedAccount: async () => ({ status: "ACTIVE" }),
    } as never,
    refreshNative: async () => null,
    markInactive: async () => {},
  });
  assertEquals(result, { provider: "composio", active: true });
  assertEquals(state.ledger.length, 1);
  assertEquals(state.ledger[0].workspace_id, "personal-workspace-1");
});

function leaseStore(overrides: Partial<YouTubeRefreshStore> = {}): YouTubeRefreshStore {
  return {
    acquireLease: async () => ({
      ok: true,
      lease_token: "33333333-3333-4333-8333-333333333333",
      expires_at: "2026-11-20T12:01:00.000Z",
    }),
    releaseLease: async () => true,
    readAccount: async () => ({
      id: "account-1",
      access_token: ["old", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: "2026-11-20T11:55:00.000Z",
      needs_reauth: false,
    }),
    storeTokenWithLease: async () => ({ ok: true }),
    recordFailureWithLease: async () => ({
      ok: true,
      needs_reauth: true,
      failure_count: 1,
      transitioned: true,
      enqueued: 0,
    }),
    ...overrides,
  };
}

Deno.test("refreshNativeYouTubeAccount reuses fresh token as already_refreshed when lease is held", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const result = await refreshNativeYouTubeAccount(
    {
      id: "account-1",
      user_id: "owner-1",
      access_token: ["stale", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: new Date(now - 60_000).toISOString(),
    },
    {
      admin: {},
      store: leaseStore({
        acquireLease: async () => ({ ok: false, reason: "lease_held" }),
        readAccount: async () => ({
          id: "account-1",
          access_token: ["winner", "acc"].join("-"),
          refresh_token: ["old", "ref"].join("-"),
          token_expires_at: new Date(now + 3_500_000).toISOString(),
          needs_reauth: false,
        }),
      }),
      nowMs: () => now,
      exchange: async () => {
        throw new Error("must not call Google when lease is held");
      },
    },
  );
  assertEquals(result.status, "already_refreshed");
  assertEquals(result.shouldAlert, false);
});

Deno.test("refreshNativeYouTubeAccount returns cooldown when lease is held and no fresh token exists", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const result = await refreshNativeYouTubeAccount(
    {
      id: "account-1",
      user_id: "owner-1",
      access_token: ["stale", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: new Date(now - 60_000).toISOString(),
    },
    {
      admin: {},
      store: leaseStore({
        acquireLease: async () => ({ ok: false, reason: "lease_held" }),
      }),
      nowMs: () => now,
      exchange: async () => {
        throw new Error("must not call Google when lease is held");
      },
    },
  );
  assertEquals(result.status, "cooldown");
  assertEquals(result.shouldAlert, false);
});

Deno.test("refreshNativeYouTubeAccount marks needs_reauth once on invalid_grant", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  let recordedInvalidGrant = 0;
  const result = await refreshNativeYouTubeAccount(
    {
      id: "account-1",
      user_id: "owner-1",
      access_token: ["stale", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: new Date(now - 60_000).toISOString(),
    },
    {
      admin: {},
      store: leaseStore({
        recordFailureWithLease: async (input) => {
          if (input.isInvalidGrant) recordedInvalidGrant++;
          return {
            ok: true,
            needs_reauth: true,
            failure_count: 1,
            transitioned: true,
            enqueued: 0,
          };
        },
      }),
      nowMs: () => now,
      exchange: async () => ({
        ok: false,
        invalidGrant: true,
        retryable: false,
        reason: "invalid_grant",
        status: 400,
      }),
    },
  );
  assertEquals(result.status, "needs_reauth");
  assertEquals(result.error, COMPOSIO_YOUTUBE_REAUTH_MESSAGE);
  assertEquals(result.shouldAlert, true);
  assertEquals(recordedInvalidGrant, 1);
});

Deno.test("admin force refresh recovers a needs_reauth account under the lease and clears the flag", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  let stored = false;
  let readNeedsReauth: boolean | null = null;
  const result = await refreshNativeYouTubeAccount(
    {
      id: "account-1",
      user_id: "owner-1",
      access_token: ["stale", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: new Date(now - 60_000).toISOString(),
      needs_reauth: true,
    },
    {
      admin: {},
      force: true,
      adminRecovery: true,
      store: leaseStore({
        // The database row is the flagged one: the under-lease guard must be
        // exercised, not just the snapshot fast path.
        readAccount: async () => {
          readNeedsReauth = true;
          return {
            id: "account-1",
            access_token: ["stale", "acc"].join("-"),
            refresh_token: ["old", "ref"].join("-"),
            token_expires_at: new Date(now - 60_000).toISOString(),
            needs_reauth: true,
          };
        },
        storeTokenWithLease: async () => {
          stored = true;
          return { ok: true };
        },
      }),
      nowMs: () => now,
      exchange: async () => ({
        ok: true,
        accessToken: ["recovered", "acc"].join("-"),
        expiresIn: 3600,
        refreshToken: null,
        scope: null,
      }),
    },
  );
  assertEquals(result.status, "refreshed");
  assertEquals(result.accessToken, ["recovered", "acc"].join("-"));
  assertEquals(stored, true);
  assertEquals(readNeedsReauth, true);
});

Deno.test("without the admin recovery option a needs_reauth account is still refused", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  let exchanged = false;
  const result = await refreshNativeYouTubeAccount(
    {
      id: "account-1",
      user_id: "owner-1",
      access_token: ["stale", "acc"].join("-"),
      refresh_token: ["old", "ref"].join("-"),
      token_expires_at: new Date(now - 60_000).toISOString(),
      needs_reauth: true,
    },
    {
      admin: {},
      force: true,
      store: leaseStore(),
      nowMs: () => now,
      exchange: async () => {
        exchanged = true;
        throw new Error("must not exchange without adminRecovery");
      },
    },
  );
  assertEquals(result.status, "needs_reauth");
  assertEquals(exchanged, false);
});

Deno.test("refreshNativeYouTubeAccount reports failed with the real reason for non-contention retryable refusals", async () => {
  const now = Date.parse("2026-11-20T12:00:00.000Z");
  const account = {
    id: "account-1",
    user_id: "owner-1",
    access_token: ["stale", "acc"].join("-"),
    refresh_token: ["old", "ref"].join("-"),
    token_expires_at: new Date(now - 60_000).toISOString(),
  };

  // lease_acquire_failed -> failed with real reason (not cooldown).
  const acquireFailed = await refreshNativeYouTubeAccount(account, {
    admin: {},
    store: leaseStore({
      acquireLease: async () => ({ ok: false, reason: "lease_acquire_failed" }),
    }),
    nowMs: () => now,
  });
  assertEquals(acquireFailed.status, "failed");
  assertEquals(acquireFailed.error, "lease_acquire_failed");
  assertEquals(acquireFailed.shouldAlert, false);

  // account_read_failed -> failed with real reason (not cooldown).
  const readFailed = await refreshNativeYouTubeAccount(account, {
    admin: {},
    store: leaseStore({
      readAccount: async () => {
        throw new Error("db read failed");
      },
    }),
    nowMs: () => now,
  });
  assertEquals(readFailed.status, "failed");
  assertEquals(readFailed.error, "account_read_failed");
  assertEquals(readFailed.shouldAlert, false);

  // refresh_answer_incomplete (e.g. non-positive expires_in) -> failed with real reason.
  const incomplete = await refreshNativeYouTubeAccount(account, {
    admin: {},
    store: leaseStore(),
    nowMs: () => now,
    exchange: async () => ({
      ok: true,
      accessToken: ["candidate", "acc"].join("-"),
      expiresIn: 0,
      refreshToken: null,
      scope: null,
    }),
  });
  assertEquals(incomplete.status, "failed");
  assertEquals(incomplete.error, "refresh_answer_incomplete");
  assertEquals(incomplete.shouldAlert, false);
});
