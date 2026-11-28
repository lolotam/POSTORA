import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.89.0";
import {
  createSupabaseYouTubeRefreshStore,
  exchangeGoogleRefreshToken,
  refreshYouTubeAccountToken,
  type AcquireLeaseResult,
  type RecordFailureWithLeaseResult,
  type StoreTokenWithLeaseResult,
  type YouTubeRefreshStore,
  type YouTubeStoredAccount,
} from "./youtubeTokenRefresh.ts";

// Construct synthetic credentials programmatically so static scanners never
// mistake test fixtures for real secrets.
const synth = (...parts: string[]) => parts.join("-");

const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const EXPIRED_AT = new Date(NOW - 5 * 60_000).toISOString();
const FRESH_AT = new Date(NOW + 55 * 60_000).toISOString();
const ACCOUNT_ID = "0ed20001-0000-4000-8000-000000000099";

interface FakeStoreState {
  account: YouTubeStoredAccount | null;
  acquireResult: AcquireLeaseResult;
  storeResult: StoreTokenWithLeaseResult;
  failureResult: RecordFailureWithLeaseResult;
  acquires: Array<{ accountId: string; ttlSeconds: number }>;
  releases: Array<{ accountId: string; leaseToken: string }>;
  reads: string[];
  stores: Array<Parameters<YouTubeRefreshStore["storeTokenWithLease"]>[0]>;
  failures: Array<Parameters<YouTubeRefreshStore["recordFailureWithLease"]>[0]>;
}

function makeFakeStore(overrides: Partial<FakeStoreState> = {}): {
  state: FakeStoreState;
  store: YouTubeRefreshStore;
} {
  const state: FakeStoreState = {
    account: {
      id: ACCOUNT_ID,
      access_token: synth("old", "access"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: false,
      is_active: true,
      auth_provider: "native",
    },
    acquireResult: {
      ok: true,
      lease_token: "11111111-1111-4111-8111-111111111111",
      expires_at: new Date(NOW + 60_000).toISOString(),
    },
    storeResult: { ok: true },
    failureResult: {
      ok: true,
      needs_reauth: true,
      failure_count: 1,
      transitioned: true,
      enqueued: 0,
    },
    acquires: [],
    releases: [],
    reads: [],
    stores: [],
    failures: [],
    ...overrides,
  };

  const store: YouTubeRefreshStore = {
    async acquireLease(accountId, ttlSeconds) {
      state.acquires.push({ accountId, ttlSeconds });
      return state.acquireResult;
    },
    async releaseLease(accountId, leaseToken) {
      state.releases.push({ accountId, leaseToken });
      return true;
    },
    async readAccount(accountId) {
      state.reads.push(accountId);
      return state.account ? { ...state.account } : null;
    },
    async storeTokenWithLease(input) {
      state.stores.push(input);
      if (state.storeResult.ok && state.account) {
        state.account = {
          ...state.account,
          access_token: input.accessToken,
          token_expires_at: input.tokenExpiresAt,
          refresh_token: input.refreshToken ?? state.account.refresh_token,
          needs_reauth: false,
        };
      }
      return state.storeResult;
    },
    async recordFailureWithLease(input) {
      state.failures.push(input);
      if (state.failureResult.ok && state.account && input.isInvalidGrant) {
        state.account = { ...state.account, needs_reauth: true };
      }
      return state.failureResult;
    },
  };

  return { state, store };
}

function withGoogleEnv<T>(fn: () => Promise<T>): Promise<T> {
  const keys = ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const;
  const saved = keys.map((k) => Deno.env.get(k));
  Deno.env.set("GOOGLE_CLIENT_ID", synth("google", "client", "id"));
  Deno.env.set("GOOGLE_CLIENT_SECRET", synth("google", "client", "secret"));
  return fn().finally(() => {
    keys.forEach((k, i) => {
      if (saved[i] === undefined) Deno.env.delete(k);
      else Deno.env.set(k, saved[i]!);
    });
  });
}

Deno.test("contender without the lease re-reads and reuses a fresh token", async () => {
  const freshAccess = synth("winner", "fresh", "access");
  const { state, store } = makeFakeStore({
    acquireResult: { ok: false, reason: "lease_held", expires_at: FRESH_AT },
    account: {
      id: ACCOUNT_ID,
      access_token: freshAccess,
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: false,
    },
  });
  let googleCalls = 0;

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("stale", "access"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
    },
    store,
    nowMs: () => NOW,
    exchange: async () => {
      googleCalls++;
      throw new Error("Google must not be called by a contender without the lease");
    },
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "reused");
    assertEquals(outcome.accessToken, freshAccess);
    assertEquals(outcome.expiresAt, FRESH_AT);
  }
  assertEquals(googleCalls, 0);
  assertEquals(state.reads.length, 1);
  assertEquals(state.stores.length, 0);
});

Deno.test("contender without the lease and nothing fresh gets a retryable refusal", async () => {
  const { state, store } = makeFakeStore({
    acquireResult: { ok: false, reason: "lease_held", expires_at: new Date(NOW + 30_000).toISOString() },
    account: {
      id: ACCOUNT_ID,
      access_token: synth("still", "expired"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: false,
    },
  });
  let googleCalls = 0;

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => {
      googleCalls++;
      throw new Error("Google must not be called without lease");
    },
  });

  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.status, "retryable_refusal");
    assertEquals(outcome.retryable, true);
    assertEquals(outcome.reason, "refresh_in_progress");
    assertEquals(outcome.needsReauth, false);
  }
  assertEquals(googleCalls, 0);
  assertEquals(state.stores.length, 0);
  assertEquals(state.failures.length, 0);
});

Deno.test("invalid_grant sets needs_reauth once and never loops", async () => {
  const { state, store } = makeFakeStore();
  let googleCalls = 0;

  const first = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => {
      googleCalls++;
      return {
        ok: false,
        invalidGrant: true,
        retryable: false,
        reason: "invalid_grant",
        status: 400,
      };
    },
  });

  assertEquals(first.ok, false);
  if (!first.ok) {
    assertEquals(first.status, "needs_reauth");
    assertEquals(first.retryable, false);
    assertEquals(first.needsReauth, true);
    assertEquals(first.reason, "invalid_grant");
  }
  assertEquals(googleCalls, 1);
  assertEquals(state.failures.length, 1);
  assertEquals(state.failures[0].isInvalidGrant, true);
  assertEquals(state.failures[0].leaseToken, "11111111-1111-4111-8111-111111111111");

  // Second attempt (even forced!) sees needs_reauth=true and never calls Google or writes again.
  const second = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    force: true,
    store,
    nowMs: () => NOW + 1_000,
    exchange: async () => {
      googleCalls++;
      throw new Error("Must never loop after invalid_grant");
    },
  });

  assertEquals(second.ok, false);
  if (!second.ok) {
    assertEquals(second.status, "needs_reauth");
    assertEquals(second.retryable, false);
    assertEquals(second.needsReauth, true);
  }
  assertEquals(googleCalls, 1);
  assertEquals(state.failures.length, 1);
  assertEquals(state.releases.length, 1);
});

Deno.test("refresh response without a refresh token keeps the stored one and passes granted scopes", async () => {
  const freshAccess = synth("google", "new", "access");
  const { state, store } = makeFakeStore();

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: freshAccess,
      expiresIn: 3600,
      refreshToken: null,
      scope: "https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.force-ssl",
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "refreshed");
    assertEquals(outcome.accessToken, freshAccess);
  }
  assertEquals(state.stores.length, 1);
  assertEquals(state.stores[0].refreshToken, null);
  assertEquals(state.stores[0].grantedScopes, [
    "https://www.googleapis.com/auth/youtube.upload",
    "https://www.googleapis.com/auth/youtube.force-ssl",
  ]);
  assertEquals(state.account?.refresh_token, synth("stored", "refresh"));
  // Lease was atomically consumed by storeTokenWithLease, so releaseLease is not needed.
  assertEquals(state.releases.length, 0);
});

Deno.test("stale holder writes nothing and reuses winner token if available", async () => {
  const winnerAccess = synth("winner", "access", "tok");
  const { state, store } = makeFakeStore({
    storeResult: { ok: false, reason: "stale_lease" },
  });

  let readCount = 0;
  const originalRead = store.readAccount;
  store.readAccount = async (id) => {
    readCount++;
    if (readCount === 2) {
      return {
        ...state.account!,
        access_token: winnerAccess,
        token_expires_at: FRESH_AT,
      };
    }
    return originalRead(id);
  };

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("stale", "candidate"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "reused");
    assertEquals(outcome.accessToken, winnerAccess);
  }
  // Account was never mutated by the stale holder.
  assertEquals(state.account?.access_token, synth("old", "access"));
});

Deno.test("no token text ever appears in logs or returned reasons", async () => {
  await withGoogleEnv(async () => {
    const secretAccess = synth("secret", "acc", "9911");
    const secretRefresh = synth("secret", "ref", "8822");
    const clientSecret = Deno.env.get("GOOGLE_CLIENT_SECRET")!;
    const logs: string[] = [];

    const { store } = makeFakeStore({
      account: {
        id: ACCOUNT_ID,
        access_token: secretAccess,
        refresh_token: secretRefresh,
        token_expires_at: EXPIRED_AT,
        needs_reauth: false,
      },
    });

    const outcome = await refreshYouTubeAccountToken({
      accountId: ACCOUNT_ID,
      store,
      nowMs: () => NOW,
      log: (_level, message) => logs.push(message),
      fetchImpl: async () => {
        const leakedQuery = new URLSearchParams([
          [["refresh", "token"].join("_"), secretRefresh],
          [["access", "token"].join("_"), secretAccess],
          [["client", "secret"].join("_"), clientSecret],
        ]).toString();
        throw new Error(`fetch failed https://oauth2.googleapis.com/token?${leakedQuery}`);
      },
    });

    assertEquals(outcome.ok, false);
    const combined = `${logs.join("\n")}\n${JSON.stringify(outcome)}`;
    for (const secret of [secretAccess, secretRefresh, clientSecret]) {
      assertEquals(combined.includes(secret), false, `leaked secret in output/logs: ${secret}`);
    }
  });
});

Deno.test("Supabase refresh store calls lease RPCs with credentials in POST body and never in URL", async () => {
  const requests: Request[] = [];
  const fakeAccess = synth("fresh", "token", "777");
  const fakeRefresh = synth("rotated", "ref", "666");
  const leaseToken = "22222222-2222-4222-8222-222222222222";

  const client = createClient("https://db.invalid", synth("service", "key"), {
    auth: { persistSession: false, autoRefreshToken: false },
    global: {
      fetch: (input, init) => {
        const req = new Request(input, init);
        requests.push(req);
        const url = new URL(req.url);
        if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
          return Promise.resolve(Response.json({ ok: true, lease_token: leaseToken, expires_at: FRESH_AT }));
        }
        if (url.pathname.endsWith("/rpc/store_youtube_refreshed_token_with_lease")) {
          return Promise.resolve(Response.json({ ok: true }));
        }
        return Promise.resolve(Response.json({
          id: ACCOUNT_ID,
          access_token: synth("old", "access"),
          refresh_token: synth("old", "refresh"),
          token_expires_at: EXPIRED_AT,
          needs_reauth: false,
          is_active: true,
          auth_provider: "native",
        }));
      },
    },
  });

  const store = createSupabaseYouTubeRefreshStore(client);
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: fakeAccess,
      expiresIn: 3600,
      refreshToken: fakeRefresh,
      scope: "https://www.googleapis.com/auth/youtube.upload",
    }),
  });

  assertEquals(outcome.ok, true);
  const rpcPaths = requests.filter((r) => r.method === "POST").map((r) => new URL(r.url).pathname);
  assertEquals(rpcPaths, [
    "/rest/v1/rpc/acquire_youtube_refresh_lease",
    "/rest/v1/rpc/store_youtube_refreshed_token_with_lease",
  ]);
  for (const req of requests) {
    assertEquals(req.url.includes(fakeAccess), false);
    assertEquals(req.url.includes(fakeRefresh), false);
  }
  const storeReq = requests.find((r) => new URL(r.url).pathname.endsWith("/rpc/store_youtube_refreshed_token_with_lease"))!;
  const body = JSON.parse(await storeReq.clone().text()) as Record<string, unknown>;
  assertEquals(body.p_account_id, ACCOUNT_ID);
  assertEquals(body.p_lease_token, leaseToken);
  assertEquals(body.p_new_access_token, fakeAccess);
  assertEquals(body.p_new_refresh_token, fakeRefresh);
  assertEquals(body.p_granted_scopes, ["https://www.googleapis.com/auth/youtube.upload"]);
});

Deno.test("double-checked read under lease reuses freshly committed token and releases lease", async () => {
  const winnerAccess = synth("just", "committed", "tok");
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: winnerAccess,
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: false,
    },
  });
  let googleCalls = 0;

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
    },
    store,
    nowMs: () => NOW,
    exchange: async () => {
      googleCalls++;
      throw new Error("Google must not be called when DB already has a fresh token");
    },
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "reused");
    assertEquals(outcome.accessToken, winnerAccess);
  }
  assertEquals(googleCalls, 0);
  assertEquals(state.releases.length, 1);
  assertEquals(state.stores.length, 0);
});

Deno.test("stale holder on invalid_grant writes nothing and reuses winner fresh token", async () => {
  const winnerAccess = synth("reconnected", "fresh", "tok");
  const { state, store } = makeFakeStore({
    failureResult: { ok: false, reason: "stale_lease" },
  });

  let reads = 0;
  const origRead = store.readAccount;
  store.readAccount = async (id) => {
    reads++;
    if (reads === 2) {
      return {
        ...state.account!,
        access_token: winnerAccess,
        token_expires_at: FRESH_AT,
        needs_reauth: false,
      };
    }
    return origRead(id);
  };

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: false,
      invalidGrant: true,
      retryable: false,
      reason: "invalid_grant",
      status: 400,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "reused");
    assertEquals(outcome.accessToken, winnerAccess);
  }
  assertEquals(state.account?.needs_reauth, false);
});

Deno.test("transient 5xx releases lease without touching needs_reauth when recordTransientFailure is false", async () => {
  await withGoogleEnv(async () => {
    const { state, store } = makeFakeStore();
    const outcome = await refreshYouTubeAccountToken({
      accountId: ACCOUNT_ID,
      store,
      nowMs: () => NOW,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
    });

    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.status, "retryable_refusal");
      assertEquals(outcome.retryable, true);
      assertEquals(outcome.needsReauth, false);
    }
    assertEquals(state.failures.length, 0);
    assertEquals(state.releases.length, 1);
  });
});

Deno.test("recordTransientFailure: retryable Google failures (503, 429, network error) never call recordFailureWithLease and always release the lease", async () => {
  await withGoogleEnv(async () => {
    const scenarios: Array<{
      label: string;
      fetchImpl: typeof fetch;
      expectedReason: string;
    }> = [
      {
        label: "503 temporarily_unavailable",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
            status: 503,
            headers: { "Content-Type": "application/json" },
          }),
        expectedReason: "refresh_refused",
      },
      {
        label: "429 rate limit",
        fetchImpl: async () =>
          new Response(JSON.stringify({ error: "rate_limit_exceeded" }), {
            status: 429,
            headers: { "Content-Type": "application/json" },
          }),
        expectedReason: "refresh_refused",
      },
      {
        label: "network timeout",
        fetchImpl: async () => {
          throw new DOMException("The operation timed out.", "TimeoutError");
        },
        expectedReason: "refresh_request_failed",
      },
    ];

    for (const scenario of scenarios) {
      const { state, store } = makeFakeStore();
      const outcome = await refreshYouTubeAccountToken({
        accountId: ACCOUNT_ID,
        recordTransientFailure: true,
        store,
        nowMs: () => NOW,
        fetchImpl: scenario.fetchImpl,
      });

      assertEquals(outcome.ok, false, scenario.label);
      if (!outcome.ok) {
        assertEquals(outcome.status, "retryable_refusal", scenario.label);
        assertEquals(outcome.retryable, true, scenario.label);
        assertEquals(outcome.reason, scenario.expectedReason, scenario.label);
        assertEquals(outcome.needsReauth, false, scenario.label);
      }
      assertEquals(state.failures.length, 0, `${scenario.label}: must not record failure`);
      assertEquals(state.releases.length, 1, `${scenario.label}: must release lease`);
    }
  });
});

Deno.test("recordTransientFailure: non-retryable non-invalid_grant failure (400 unauthorized_client) records failure with isInvalidGrant=false", async () => {
  await withGoogleEnv(async () => {
    const { state, store } = makeFakeStore({
      failureResult: {
        ok: true,
        needs_reauth: false,
        failure_count: 1,
        transitioned: false,
        enqueued: 0,
      },
    });
    const outcome = await refreshYouTubeAccountToken({
      accountId: ACCOUNT_ID,
      recordTransientFailure: true,
      store,
      nowMs: () => NOW,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "unauthorized_client" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    });

    assertEquals(outcome.ok, false);
    if (!outcome.ok) {
      assertEquals(outcome.status, "failed");
      assertEquals(outcome.retryable, false);
      assertEquals(outcome.reason, "refresh_refused");
      assertEquals(outcome.needsReauth, false);
    }
    assertEquals(state.failures.length, 1);
    assertEquals(state.failures[0].isInvalidGrant, false);
    assertEquals(state.releases.length, 0, "lease was consumed by recordFailureWithLease");
  });
});

Deno.test("fresh snapshot fast-path skips lease and Google entirely", async () => {
  const freshAccess = synth("already", "fresh", "tok");
  const { state, store } = makeFakeStore();
  let googleCalls = 0;

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: freshAccess,
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: false,
    },
    store,
    nowMs: () => NOW,
    exchange: async () => {
      googleCalls++;
      throw new Error("Should not call Google for fresh snapshot");
    },
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "fresh");
    assertEquals(outcome.accessToken, freshAccess);
  }
  assertEquals(googleCalls, 0);
  assertEquals(state.acquires.length, 0);
});

Deno.test("force with no known prior token never reports reused; the lease holder refreshes", async () => {
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("fresh", "but", "suspect"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: false,
    },
  });

  // The caller does not know which token it last saw, so force has nothing to
  // compare against: reuse would silently re-send the very token the caller
  // suspects. The lease holder must refresh instead.
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      refresh_token: synth("stored", "refresh"),
    },
    force: true,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("forced", "fresh"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "refreshed");
    assertEquals(outcome.accessToken, synth("forced", "fresh"));
  }
  assertEquals(state.stores.length, 1);

  // A prior token that differs from the stored one is still reusable: the
  // stored fresh token is provably not the one that just failed.
  const reuse = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("different", "prior"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
    },
    force: true,
    store,
    nowMs: () => NOW,
    exchange: async () => {
      throw new Error("must not call Google when a different fresh token was stored");
    },
  });
  assertEquals(reuse.ok, true);
  if (reuse.ok) assertEquals(reuse.status, "reused");
});

Deno.test("adminRecovery on a flagged row exchanges instead of reusing a fresh token", async () => {
  // The whole point of admin recovery is to re-test the grant at Google: a
  // fresh token on a flagged row must NOT be reported as reused, or the flag
  // never clears. An unflagged fresh row still reuses (second half).
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("fresh", "flagged"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: true,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("prior", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
    adminRecovery: true,
    force: true,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("recovered", "tok"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "refreshed");
    assertEquals(outcome.accessToken, synth("recovered", "tok"));
  }
  assertEquals(state.stores.length, 1);
  assertEquals(state.account?.needs_reauth, false);
});

Deno.test("an unflagged row with a fresh token still reuses under force", async () => {
  const storedAccess = synth("fresh", "unflagged");
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: storedAccess,
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: false,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("different", "prior"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
    },
    adminRecovery: true,
    force: true,
    store,
    nowMs: () => NOW,
    exchange: async () => {
      throw new Error("an unflagged fresh token must be reused, not re-fetched");
    },
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "reused");
    assertEquals(outcome.accessToken, storedAccess);
  }
  assertEquals(state.stores.length, 0);
});

Deno.test("adminRecovery without force on a flagged fresh row still exchanges", async () => {
  // The fresh fast-path shortcut must not swallow a flagged snapshot either:
  // a caller asking for recovery of a flagged account gets the exchange (and
  // the persisted flag clear), never a silent "fresh" that leaves the flag.
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("fresh", "flagged"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: true,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("fresh", "flagged"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: FRESH_AT,
      needs_reauth: true,
    },
    adminRecovery: true,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("recovered", "tok"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "refreshed");
    assertEquals(outcome.accessToken, synth("recovered", "tok"));
  }
  assertEquals(state.stores.length, 1);
  assertEquals(state.account?.needs_reauth, false);
});

Deno.test("provider refusal log maps OAuth codes to fixed labels and never echoes raw provider error text", async () => {
  await withGoogleEnv(async () => {
    const lines: string[] = [];
    const log = (level: "warn" | "error" | "info", message: string) => {
      lines.push(message);
    };

    // A provider error string nobody recognizes, built to look exactly like
    // the credential-shaped text a hostile endpoint would echo back.
    const credentialShaped = ["ya29", "bearer", "secret-value"].join("-");
    const refused = await exchangeGoogleRefreshToken(synth("stored", "refresh"), {
      accountId: ACCOUNT_ID,
      fetchImpl: async () =>
        new Response(
          JSON.stringify({
            error: credentialShaped,
            error_description: `${credentialShaped} tells more`,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
      log,
    });

    assertEquals(refused.ok, false);
    if (!refused.ok) {
      assertEquals(refused.reason, "refresh_refused");
      assertEquals(refused.status, 400);
    }
    const all = lines.join("\n");
    assertEquals(all.includes(credentialShaped), false);
    assertEquals(all.includes("unrecognized_provider_error"), true);
    assertEquals(all.includes("status=400"), true);

    // A recognized OAuth code keeps its fixed label.
    lines.length = 0;
    await exchangeGoogleRefreshToken(synth("stored", "refresh"), {
      accountId: ACCOUNT_ID,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      log,
    });
    assertEquals(lines.join("\n").includes("code=invalid_grant"), true);
    assertEquals(lines.join("\n").includes("secret-value"), false);
  });
});

Deno.test("adminRecovery exchanges under the lease for a needs_reauth account and the store clears the flag", async () => {
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
    adminRecovery: true,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("recovered", "tok"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) {
    assertEquals(outcome.status, "refreshed");
    assertEquals(outcome.accessToken, synth("recovered", "tok"));
  }
  assertEquals(state.stores.length, 1);
  // The flag clears only through the persisted write, never in place.
  assertEquals(state.account?.needs_reauth, false);
});

Deno.test("without adminRecovery a needs_reauth account is still refused without an exchange", async () => {
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
    store,
    nowMs: () => NOW,
    exchange: async () => {
      throw new Error("must not exchange without adminRecovery");
    },
  });

  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.status, "needs_reauth");
    assertEquals(outcome.needsReauth, true);
  }
  assertEquals(state.acquires.length, 0);
  assertEquals(state.stores.length, 0);
});

Deno.test("adminRecovery reads needs_reauth from the database row, not only the snapshot", async () => {
  const { state, store } = makeFakeStore({
    account: {
      id: ACCOUNT_ID,
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
      needs_reauth: true,
    },
  });

  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {
      access_token: synth("stale", "tok"),
      refresh_token: synth("stored", "refresh"),
      token_expires_at: EXPIRED_AT,
    },
    adminRecovery: true,
    store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("recovered", "tok"),
      expiresIn: 3600,
      refreshToken: null,
      scope: null,
    }),
  });

  assertEquals(outcome.ok, true);
  if (outcome.ok) assertEquals(outcome.status, "refreshed");
  assertEquals(state.stores.length, 1);
});

Deno.test("healthNeutral: invalid_grant records NOTHING (no needs_reauth, no failure) and still releases the lease", async () => {
  const { state, store } = makeFakeStore();
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    healthNeutral: true,
    nowMs: () => NOW,
    exchange: async () => ({ ok: false, invalidGrant: true, retryable: false, reason: "invalid_grant", status: 400 }),
  });
  assertEquals(outcome.ok, false);
  if (!outcome.ok) {
    assertEquals(outcome.reason, "invalid_grant");
    assertEquals(outcome.needsReauth, true, "the caller is still told the grant is gone");
  }
  assertEquals(state.failures.length, 0, "no failure was recorded");
  assertEquals(state.account?.needs_reauth, false, "the stored account health is untouched");
  assertEquals(state.releases.length, 1, "the lease was released, not consumed");
});

Deno.test("healthNeutral: a successful exchange stores the token but never rewrites granted scopes", async () => {
  const { state, store } = makeFakeStore();
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store,
    healthNeutral: true,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("new", "access"),
      expiresIn: 3600,
      refreshToken: null,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    }),
  });
  assertEquals(outcome.ok, true);
  assertEquals(state.stores.length, 1);
  assertEquals(state.stores[0].grantedScopes, null, "scope grants are never rewritten by a health-neutral caller");
});

Deno.test("default mode is unchanged: the same exchange DOES record needs_reauth and DOES store scopes", async () => {
  const bad = makeFakeStore();
  await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store: bad.store,
    nowMs: () => NOW,
    exchange: async () => ({ ok: false, invalidGrant: true, retryable: false, reason: "invalid_grant", status: 400 }),
  });
  assertEquals(bad.state.failures.length, 1);

  const good = makeFakeStore();
  await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    store: good.store,
    nowMs: () => NOW,
    exchange: async () => ({
      ok: true,
      accessToken: synth("new", "access"),
      expiresIn: 3600,
      refreshToken: null,
      scope: "https://www.googleapis.com/auth/youtube.readonly",
    }),
  });
  assertEquals(good.state.stores[0].grantedScopes, ["https://www.googleapis.com/auth/youtube.readonly"]);
});

Deno.test("healthNeutral stores through the neutral RPC, which carries no scope parameter; the default RPC is unchanged", async () => {
  const leaseToken = "22222222-2222-4222-8222-222222222222";
  for (const neutral of [true, false]) {
    const rpcs: Array<{ path: string; body: Record<string, unknown> }> = [];
    const client = createClient("https://db.invalid", synth("service", "key"), {
      auth: { persistSession: false, autoRefreshToken: false },
      global: {
        fetch: async (input, init) => {
          const req = new Request(input, init);
          const url = new URL(req.url);
          if (req.method === "POST") rpcs.push({ path: url.pathname, body: JSON.parse(await req.clone().text()) });
          if (url.pathname.endsWith("/rpc/acquire_youtube_refresh_lease")) {
            return Response.json({ ok: true, lease_token: leaseToken, expires_at: FRESH_AT });
          }
          if (url.pathname.includes("/rpc/store_youtube_refreshed_token_with_lease")) return Response.json({ ok: true });
          return Response.json({
            id: ACCOUNT_ID, access_token: synth("old", "access"), refresh_token: synth("old", "refresh"),
            token_expires_at: EXPIRED_AT, needs_reauth: false, is_active: true, auth_provider: "native",
          });
        },
      },
    });
    const outcome = await refreshYouTubeAccountToken({
      accountId: ACCOUNT_ID,
      store: createSupabaseYouTubeRefreshStore(client),
      healthNeutral: neutral,
      nowMs: () => NOW,
      exchange: async () => ({
        ok: true, accessToken: synth("new", "access"), expiresIn: 3600, refreshToken: null,
        scope: "https://www.googleapis.com/auth/youtube.upload",
      }),
    });
    assertEquals(outcome.ok, true);
    const store = rpcs.find((r) => r.path.includes("/rpc/store_youtube_refreshed_token_with_lease"))!;
    assertEquals(store.path.endsWith("_neutral"), neutral);
    assertEquals("p_granted_scopes" in store.body, !neutral, "the neutral RPC has no scope parameter at all");
  }
});