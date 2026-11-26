import { assertEquals, assertThrows } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { refreshYouTubeAccountToken } from "../_shared/youtubeTokenRefresh.ts";
import { YOUTUBE_ANALYTICS_REQUIRED_SCOPES } from "./contracts.ts";
import { createBoundYouTubeAnalyticsRefreshStore } from "./credentials.ts";
import type { YouTubeAnalyticsBinding, YouTubeAnalyticsRpcRunner } from "./decision.ts";

const OWNER_ID = "0ee00001-0000-4000-8000-000000000001";
const ACCOUNT_ID = "0ee20001-0000-4000-8000-000000000021";
const LEASE_ID = "0ee50001-0000-4000-8000-000000000051";
const NOW = Date.parse("2026-11-20T12:00:00.000Z");
const BINDING: YouTubeAnalyticsBinding = {
  accountId: ACCOUNT_ID,
  ownerId: OWNER_ID,
  channelId: "UCfixturechannel000000001",
  bindingGeneration: 4,
  bindingIncarnation: "0ee40001-0000-4000-8000-000000000041",
  connectionRevision: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  provider: "native",
  needsReauth: false,
  grantedScopes: [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
  consent: { state: "accepted", version: 1 },
};

function decision(reason = "ok", needsReauth = false, expired = false) {
  return {
    ok: reason === "ok",
    reason,
    channel_id: BINDING.channelId,
    binding_generation: BINDING.bindingGeneration,
    binding_incarnation: BINDING.bindingIncarnation,
    connection_revision: BINDING.connectionRevision,
    provider: "native",
    needs_reauth: needsReauth,
    granted_scopes: BINDING.grantedScopes,
    consent: { state: "accepted", version: 1 },
    ...(reason === "ok"
      ? {
        credentials: {
          access_token: "stored-access",
          refresh_token: "stored-refresh",
          token_expires_at: new Date(NOW + (expired ? -60_000 : 3_600_000)).toISOString(),
        },
      }
      : {}),
  };
}

function rpcMock(
  answers: Record<string, (args: Record<string, unknown>) => { data: unknown; error?: unknown }>,
) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: YouTubeAnalyticsRpcRunner = (fn, args) => {
    calls.push({ fn, args });
    const answer = answers[fn];
    if (!answer) return Promise.resolve({ data: null, error: { code: "UNEXPECTED" } });
    const result = answer(args);
    return Promise.resolve({ data: result.data, error: result.error ?? null });
  };
  return { rpc, calls };
}

Deno.test("bound read uses decide with the admitted binding and credentials", async () => {
  const { rpc, calls } = rpcMock({
    youtube_analytics_stage5_decide: () => ({ data: decision() }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  assertEquals(await store.readAccount(ACCOUNT_ID), {
    id: ACCOUNT_ID,
    access_token: "stored-access",
    refresh_token: "stored-refresh",
    token_expires_at: new Date(NOW + 3_600_000).toISOString(),
    needs_reauth: false,
    is_active: true,
    auth_provider: "native",
  });
  assertEquals(store.lastDenial, null);
  assertEquals(calls[0].args.p_expected_channel, BINDING.channelId);
  assertEquals(calls[0].args.p_expected_generation, BINDING.bindingGeneration);
  assertEquals(calls[0].args.p_expected_incarnation, BINDING.bindingIncarnation);
  assertEquals(calls[0].args.p_with_credentials, true);
});

Deno.test("needs_reauth refusal reaches the helper refusal path and records lastDenial", async () => {
  const { rpc } = rpcMock({
    youtube_analytics_stage5_decide: () => ({ data: decision("reconnect_required", true) }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  assertEquals(await store.readAccount(ACCOUNT_ID), {
    id: ACCOUNT_ID,
    access_token: null,
    refresh_token: null,
    token_expires_at: null,
    needs_reauth: true,
    is_active: true,
    auth_provider: "native",
  });
  assertEquals(store.lastDenial?.code, "reconnect_required");
});

for (const reason of ["connection_changed", "not_enabled", "consent_required", "missing_scope"] as const) {
  Deno.test(`bound read returns null and preserves ${reason}`, async () => {
    const { rpc } = rpcMock({
      youtube_analytics_stage5_decide: () => ({ data: decision(reason) }),
    });
    const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
    assertEquals(await store.readAccount(ACCOUNT_ID), null);
    assertEquals(store.lastDenial?.code, reason);
  });
}

Deno.test("bound acquire sends binding, scopes, purpose and TTL", async () => {
  const { rpc, calls } = rpcMock({
    youtube_analytics_stage5_acquire_lease: () => ({
      data: { ok: true, lease_token: LEASE_ID, expires_at: "2026-11-20T12:01:00.000Z" },
    }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  assertEquals(await store.acquireLease(ACCOUNT_ID, 60), {
    ok: true,
    lease_token: LEASE_ID,
    expires_at: "2026-11-20T12:01:00.000Z",
  });
  assertEquals(calls[0].args, {
    p_owner_id: OWNER_ID,
    p_account_id: ACCOUNT_ID,
    p_expected_channel: BINDING.channelId,
    p_expected_generation: BINDING.bindingGeneration,
    p_expected_incarnation: BINDING.bindingIncarnation,
    p_required_scopes: [...YOUTUBE_ANALYTICS_REQUIRED_SCOPES],
    p_purpose_version: 1,
    p_ttl_seconds: 60,
  });
});

Deno.test("lease_held is retryable by the helper and is not a denial", async () => {
  const { rpc } = rpcMock({
    youtube_analytics_stage5_acquire_lease: () => ({
      data: { ok: false, reason: "lease_held", expires_at: "2026-11-20T12:01:00.000Z" },
    }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  assertEquals(await store.acquireLease(ACCOUNT_ID, 60), {
    ok: false,
    reason: "lease_held",
    expires_at: "2026-11-20T12:01:00.000Z",
  });
  assertEquals(store.lastDenial, null);
});

for (const [name, answer, code] of [
  ["binding refusal", { data: { ok: false, reason: "connection_changed" } }, "connection_changed"],
  ["RPC error", { data: null, error: { code: "XX000" } }, "settings_unavailable"],
] as const) {
  Deno.test(`bound acquire maps ${name} to a permanent helper refusal`, async () => {
    const { rpc } = rpcMock({ youtube_analytics_stage5_acquire_lease: () => answer });
    const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
    assertEquals(await store.acquireLease(ACCOUNT_ID, 60), { ok: false, reason: "account_not_found" });
    assertEquals(store.lastDenial?.code, code);
  });
}

Deno.test("bound store sends only token fields and preserves a typed refusal", async () => {
  const { rpc, calls } = rpcMock({
    youtube_analytics_stage5_store_token: () => ({ data: { ok: false, reason: "connection_changed" } }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  const input = {
    accountId: ACCOUNT_ID,
    leaseToken: LEASE_ID,
    accessToken: "new-access",
    tokenExpiresAt: "2026-11-20T13:00:00.000Z",
    refreshToken: "new-refresh",
    grantedScopes: null,
    healthNeutral: true,
  };
  assertEquals(await store.storeTokenWithLease(input), { ok: false, reason: "connection_changed" });
  assertEquals(store.lastDenial?.code, "connection_changed");
  assertEquals(calls[0].args.p_new_access_token, "new-access");
  assertEquals(calls[0].args.p_new_refresh_token, "new-refresh");
  assertEquals("grantedScopes" in calls[0].args, false);
  assertEquals("p_granted_scopes" in calls[0].args, false);
});

Deno.test("releaseLease delegates to the unchanged shared RPC and recordFailure always throws", async () => {
  const { rpc, calls } = rpcMock({ release_youtube_refresh_lease: () => ({ data: true }) });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  assertEquals(await store.releaseLease(ACCOUNT_ID, LEASE_ID), true);
  assertEquals(calls[0], {
    fn: "release_youtube_refresh_lease",
    args: { p_account_id: ACCOUNT_ID, p_lease_token: LEASE_ID },
  });
  assertThrows(
    () => store.recordFailureWithLease({
      accountId: ACCOUNT_ID,
      leaseToken: LEASE_ID,
      errorMessage: "synthetic",
      isInvalidGrant: true,
    }),
    Error,
    "recordFailureWithLease must never be called in healthNeutral mode",
  );
});

Deno.test("real helper refreshes an expired token once through the bound health-neutral store", async () => {
  const { rpc, calls } = rpcMock({
    youtube_analytics_stage5_decide: () => ({ data: decision("ok", false, true) }),
    youtube_analytics_stage5_acquire_lease: () => ({
      data: { ok: true, lease_token: LEASE_ID, expires_at: "2026-11-20T12:01:00.000Z" },
    }),
    youtube_analytics_stage5_store_token: () => ({ data: { ok: true } }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {},
    healthNeutral: true,
    recordTransientFailure: false,
    store,
    nowMs: () => NOW,
    exchange: () => Promise.resolve({
      ok: true,
      accessToken: "refreshed-access",
      expiresIn: 3600,
      refreshToken: "rotated-refresh",
      scope: YOUTUBE_ANALYTICS_REQUIRED_SCOPES.join(" "),
    }),
  });
  assertEquals(outcome.ok, true);
  assertEquals(outcome.ok && outcome.status, "refreshed");
  const stores = calls.filter((call) => call.fn === "youtube_analytics_stage5_store_token");
  assertEquals(stores.length, 1);
  assertEquals(stores[0].args.p_new_access_token, "refreshed-access");
  assertEquals(stores[0].args.p_new_refresh_token, "rotated-refresh");
  assertEquals("p_granted_scopes" in stores[0].args, false);
  assertEquals(calls.some((call) => call.fn === "record_youtube_refresh_failure_with_lease"), false);
});

Deno.test("real helper never calls recordFailureWithLease for invalid_grant in healthNeutral mode", async () => {
  const { rpc, calls } = rpcMock({
    youtube_analytics_stage5_decide: () => ({ data: decision("ok", false, true) }),
    youtube_analytics_stage5_acquire_lease: () => ({
      data: { ok: true, lease_token: LEASE_ID, expires_at: "2026-11-20T12:01:00.000Z" },
    }),
    release_youtube_refresh_lease: () => ({ data: true }),
  });
  const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
  const outcome = await refreshYouTubeAccountToken({
    accountId: ACCOUNT_ID,
    snapshot: {},
    healthNeutral: true,
    recordTransientFailure: false,
    store,
    nowMs: () => NOW,
    exchange: () => Promise.resolve({ ok: false, invalidGrant: true, retryable: false, reason: "invalid_grant" }),
  });
  assertEquals(outcome.ok, false);
  assertEquals(!outcome.ok && outcome.status, "needs_reauth");
  assertEquals(calls.some((call) => call.fn === "youtube_analytics_stage5_store_token"), false);
  assertEquals(calls.filter((call) => call.fn === "release_youtube_refresh_lease").length, 1);
});

Deno.test("disconnect during exchange refuses the store, rollout withdrawal still permits it", async () => {
  for (const [storeAnswer, expectedDenial] of [
    [{ ok: false, reason: "connection_changed" }, "connection_changed"],
    [{ ok: true }, null],
  ] as const) {
    const { rpc } = rpcMock({
      youtube_analytics_stage5_store_token: () => ({ data: storeAnswer }),
    });
    const store = createBoundYouTubeAnalyticsRefreshStore({ rpc, binding: BINDING });
    const result = await store.storeTokenWithLease({
      accountId: ACCOUNT_ID,
      leaseToken: LEASE_ID,
      accessToken: "new-access",
      tokenExpiresAt: "2026-11-20T13:00:00.000Z",
      refreshToken: null,
      grantedScopes: null,
      healthNeutral: true,
    });
    assertEquals(result.ok, storeAnswer.ok);
    assertEquals(store.lastDenial?.code ?? null, expectedDenial);
  }
});
