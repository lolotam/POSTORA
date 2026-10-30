/**
 * The store's contract.
 *
 * WHAT THIS SUITE PINS
 *
 *   The RPC names and argument names the feature actually calls, the strict
 *   handling of the driver envelope, the owner-scoped viewer projection and
 *   the protected credential resolution.
 *
 * WHY THE RPC NAMES ARE ASSERTED
 *
 *   The accepted job contract is a set of PostgreSQL functions with exact
 *   parameter names. A store that calls `claim_instagram_collection_jobs`
 *   with `p_kind` instead of `p_target_kind` fails at runtime, in
 *   production, on the first claim. The names are therefore part of the
 *   store's contract and they are pinned here.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  CompetitorStoreError,
  createCompetitorOwnerStore,
  createCompetitorServiceStore,
  SELECTOR_TOKEN_SENTINEL,
  type CompetitorRpcCaller,
  type ServiceOwnedTable,
  type ServiceReadPort,
} from "./store.ts";

const JOB_ID = "5c1b0003-0000-4000-8000-000000000003";
const WATCHLIST_ID = "c1000000-0000-4000-8000-000000000001";
const OWNER_ID = "a1000000-0000-4000-8000-000000000001";
const INVENTORY = {
  truncated: false,
  partial: false,
  window_covered: false,
  oldest_returned_at: null,
  gap_reason: null,
  pages_fetched: 0,
};

/** The coverage a successful capture carries on the wire. */
const COVERAGE_PAYLOAD = {
  capture_started_at: "2026-10-29T02:00:00.000Z",
  capture_ended_at: "2026-10-29T02:00:05.000Z",
  oldest_returned_at: null,
  ordering_verified: false,
  cursor_present: false,
  exhausted: true,
  truncated: false,
  gap_reason: null,
};

/** The versioned receipt the database sends back after storing it. */
const V2_RECEIPT = {
  version: 2,
  job_id: JOB_ID,
  job_generation: 1,
  outcome: "completed",
  source: "official",
  watchlist_id: WATCHLIST_ID,
  captured_on: "2026-10-29",
  written: 1,
  media_count: 0,
  captured_at: "2026-10-29T02:00:00+00:00",
  coverage: {
    watchlist_id: WATCHLIST_ID,
    user_id: OWNER_ID,
    captured_on: "2026-10-29",
    captured_at: "2026-10-29T02:00:00+00:00",
    source: "official",
    job_generation: 1,
    capture_started_at: "2026-10-29T02:00:00.000Z",
    capture_ended_at: "2026-10-29T02:00:05.000Z",
    oldest_returned_at: null,
    ordering_verified: false,
    cursor_present: false,
    exhausted: true,
    truncated: false,
    gap_reason: null,
    inventory_complete: true,
  },
};

const V2_PAYLOAD = {
  outcome: "completed" as const,
  source: "official" as const,
  profile: { metrics: {} },
  media: [],
  coverage: COVERAGE_PAYLOAD,
};

interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function recorder(): {
  calls: RpcCall[];
  rpc: CompetitorRpcCaller;
} {
  const calls: RpcCall[] = [];
  const rpc: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return { data: null, error: null };
  };
  return { calls, rpc };
}

function readPort(
  responses: Partial<Record<ServiceOwnedTable, unknown>> = {},
): { reads: ServiceReadPort; calls: Array<{ table: string; filters: Record<string, unknown> }> } {
  const calls: Array<{ table: string; filters: Record<string, unknown> }> = [];
  const reads: ServiceReadPort = {
    async readOne(table, _columns, filters) {
      calls.push({ table, filters });
      const row = responses[table];
      return { data: row ?? null, error: null };
    },
    async readMany(table, _columns, filters, _limit) {
      calls.push({ table, filters });
      const rows = responses[table];
      return { data: rows ?? [], error: null };
    },
  };
  return { reads, calls };
}

Deno.test("the owner enqueue calls the accepted RPC with its parameter names", async () => {
  const { calls, rpc } = recorder();
  const rpcWithResult: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return {
      data: {
        accepted: true,
        reason: "forced",
        job_id: "5c1b0003-0000-4000-8000-000000000003",
        job_generation: 2,
        status: "queued",
        captured_on: "2026-10-29",
        created: true,
        accepted_at: "2026-10-29T02:00:00.123456+00:00",
      },
      error: null,
    };
  };

  const store = createCompetitorOwnerStore(rpcWithResult);
  const receipt = await store.enqueueCompetitorJob({
    watchlistId: "c1000000-0000-4000-8000-000000000001",
    mode: "force",
  });

  assertEquals(calls[0]!.name, "enqueue_instagram_collection_job");
  assertEquals(calls[0]!.args.p_target_kind, "competitor");
  assertEquals(calls[0]!.args.p_target_id, "c1000000-0000-4000-8000-000000000001");
  assertEquals(calls[0]!.args.p_mode, "force");
  assertEquals(receipt.accepted, true);
  assertEquals(receipt.jobId, "5c1b0003-0000-4000-8000-000000000003");
  assertEquals(receipt.jobGeneration, 2);
  assert(receipt.capturedOn === "2026-10-29");
});

Deno.test("a throttled enqueue is a typed receipt and not an error", async () => {
  const rpc: CompetitorRpcCaller = async () => ({
    data: {
      accepted: false,
      reason: "throttled",
      retry_after_seconds: 421,
      captured_on: "2026-10-29",
    },
    error: null,
  });

  const store = createCompetitorOwnerStore(rpc);
  const receipt = await store.enqueueCompetitorJob({
    watchlistId: "c1000000-0000-4000-8000-000000000001",
    mode: "normal",
  });

  assertEquals(receipt.accepted, false);
  assertEquals(receipt.reason, "throttled");
  assertEquals(receipt.retryAfterSeconds, 421);
  assertEquals(receipt.jobId, null);
});

Deno.test("the owner status calls the accepted RPC with its parameter names", async () => {
  const calls: RpcCall[] = [];
  const rpc: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return {
      data: {
        target_kind: "competitor",
        target_id: "c1000000-0000-4000-8000-000000000001",
        captured_on: "2026-10-29",
        status: "queued",
        job_generation: 1,
        attempts: 1,
        due_at: "2026-10-29T02:00:00+00:00",
        next_retry_at: null,
        last_attempt_at: null,
        last_partial_at: null,
        last_success_at: null,
        reason_code: null,
        inventory: INVENTORY,
        pending_operations: 2,
      },
      error: null,
    };
  };

  const store = createCompetitorOwnerStore(rpc);
  const status = await store.readCompetitorStatus({
    watchlistId: "c1000000-0000-4000-8000-000000000001",
    capturedOn: null,
  });

  assertEquals(calls[0]!.name, "read_instagram_collection_job_status");
  assertEquals(calls[0]!.args.p_target_kind, "competitor");
  assertEquals(calls[0]!.args.p_target_id, "c1000000-0000-4000-8000-000000000001");
  assertEquals(calls[0]!.args.p_capture_day, null);
  assertEquals(status.status, "queued");
  assertEquals(status.pendingOperations, 2);
});

Deno.test("the service RPCs are called with the accepted parameter names", async () => {
  const { calls, rpc } = recorder();
  const responses: Record<string, unknown> = {
    list_due_competitor_collection_targets: [],
    enqueue_instagram_collection_jobs_service: { owner_id: "u", captured_on: "2026-10-29", accepted: 1, results: [] },
    claim_instagram_collection_jobs: [],
    attach_instagram_collection_job_viewer_context: {
      job_id: "j",
      job_generation: 1,
      viewer_social_account_id: "a",
      credential_generation: 3,
      login_kind: "page_linked",
      granted_scopes: [],
    },
    persist_competitor_collection_result_v2: V2_RECEIPT,
    record_instagram_provider_throttle: {
      bucket_key: "k",
      usage_percent: 10,
      throttled_until: null,
      job_id: JOB_ID,
      status: "retry",
    },
  };

  const routed: CompetitorRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return { data: responses[name] ?? null, error: null };
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc: routed, reads });

  await store.listDueTargets({
    limit: 50,
    cursor: { dueAt: "2026-10-01T00:00:00+00:00", id: "c1" },
  });
  await store.enqueueService({ ownerId: "u", watchlistIds: ["c1", "c2"] });
  await store.claimCompetitorJobs({ limit: 50 });
  await store.attachViewerContext({
    jobId: "j",
    claimToken: "t",
    jobGeneration: 1,
    viewerSocialAccountId: "a",
  });
  await store.persistResult({
    jobId: JOB_ID,
    claimToken: "t",
    jobGeneration: 1,
    payload: V2_PAYLOAD,
  });
  await store.recordThrottle({
    bucketKey: "k",
    usagePercent: 10,
    throttledUntil: null,
    jobId: JOB_ID,
    claimToken: "t",
    jobGeneration: 1,
  });

  assertEquals(calls[0]!.name, "list_due_competitor_collection_targets");
  assertEquals(calls[0]!.args.p_limit, 50);
  assertEquals(calls[0]!.args.p_after_due_at, "2026-10-01T00:00:00+00:00");
  assertEquals(calls[0]!.args.p_after_id, "c1");

  assertEquals(calls[1]!.name, "enqueue_instagram_collection_jobs_service");
  assertEquals(calls[1]!.args.p_owner_id, "u");
  assertEquals(
    JSON.stringify(calls[1]!.args.p_requests),
    JSON.stringify([
      { target_kind: "competitor", target_id: "c1", mode: "normal" },
      { target_kind: "competitor", target_id: "c2", mode: "normal" },
    ]),
  );

  assertEquals(calls[2]!.name, "claim_instagram_collection_jobs");
  assertEquals(calls[2]!.args.p_target_kind, "competitor");
  assertEquals(calls[2]!.args.p_limit, 50);

  assertEquals(calls[3]!.name, "attach_instagram_collection_job_viewer_context");
  assertEquals(calls[3]!.args.p_job_id, "j");
  assertEquals(calls[3]!.args.p_claim_token, "t");
  assertEquals(calls[3]!.args.p_job_generation, 1);
  assertEquals(calls[3]!.args.p_viewer_social_account_id, "a");

  assertEquals(calls[4]!.name, "persist_competitor_collection_result_v2");
  assertEquals(calls[4]!.args.p_job_id, JOB_ID);
  assertEquals(calls[4]!.args.p_claim_generation, undefined);
  assertEquals(calls[4]!.args.p_job_generation, 1);
  assertEquals(
    JSON.stringify((calls[4]!.args.p_payload as { coverage: unknown }).coverage),
    JSON.stringify(COVERAGE_PAYLOAD),
    "the coverage travels with the payload",
  );

  // The throttle RPC has a different parameter set from the one the owner
  // worker used. The names are the accepted ones.
  assertEquals(calls[5]!.name, "record_instagram_provider_throttle");
  assertEquals(calls[5]!.args.p_bucket_key, "k");
  assertEquals(calls[5]!.args.p_usage_percent, 10);
  assertEquals(calls[5]!.args.p_throttled_until, null);
  assertEquals(calls[5]!.args.p_job_id, JOB_ID);
  assertEquals(calls[5]!.args.p_claim_token, "t");
  assertEquals(calls[5]!.args.p_job_generation, 1);
});

Deno.test("a missing error property is a failure and never a completed read", async () => {
  const rpc: CompetitorRpcCaller = async () => ({ data: { accepted: true } });

  const store = createCompetitorOwnerStore(rpc);
  const error = await assertRejects(
    () =>
      store.enqueueCompetitorJob({
        watchlistId: "c1000000-0000-4000-8000-000000000001",
        mode: "normal",
      }),
    CompetitorStoreError,
  );

  assertEquals(error.failure, "read_failed");
});

Deno.test("a driver error is classified by its SQLSTATE and its text is dropped", async () => {
  const refusals: Array<{ code: string; failure: string }> = [
    { code: "42501", failure: "forbidden" },
    { code: "P0002", failure: "not_found" },
    { code: "40001", failure: "stale_claim" },
    { code: "22023", failure: "invalid" },
    { code: "PGRST202", failure: "schema_unavailable" },
  ];

  for (const refusal of refusals) {
    const rpc: CompetitorRpcCaller = async () => ({
      data: null,
      error: { code: refusal.code, message: "SQL fragment with a secret token" },
    });

    const store = createCompetitorOwnerStore(rpc);
    const error = await assertRejects(
      () =>
        store.enqueueCompetitorJob({
          watchlistId: "c1000000-0000-4000-8000-000000000001",
          mode: "normal",
        }),
      CompetitorStoreError,
    );

    assertEquals(error.failure, refusal.failure);
    assertEquals(error.message.includes("secret token"), false);
  }
});

Deno.test("the viewer projection keeps only the trusted page-linked accounts", async () => {
  const { reads, calls } = readPort({
    social_accounts: [
      {
        id: "acc-page",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-page",
        is_active: true,
        needs_reauth: false,
        connected_at: "2026-01-01T00:00:00Z",
      },
      {
        id: "acc-direct",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-direct",
        is_active: true,
        needs_reauth: false,
        connected_at: "2026-02-01T00:00:00Z",
      },
      {
        id: "acc-unknown",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-unknown",
        is_active: true,
        needs_reauth: false,
        connected_at: "2026-03-01T00:00:00Z",
      },
      {
        id: "acc-noscope",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-noscope",
        is_active: true,
        needs_reauth: false,
        connected_at: "2026-04-01T00:00:00Z",
      },
      {
        id: "acc-inactive",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-inactive",
        is_active: false,
        needs_reauth: false,
        connected_at: "2026-05-01T00:00:00Z",
      },
      {
        id: "acc-reauth",
        user_id: "u1",
        platform: "instagram",
        platform_user_id: "ig-reauth",
        is_active: true,
        needs_reauth: true,
        connected_at: "2026-06-01T00:00:00Z",
      },
    ],
    instagram_account_capabilities: [
      {
        social_account_id: "acc-page",
        user_id: "u1",
        platform: "instagram",
        login_kind: "page_linked",
        permission_read_state: "ok",
        granted_scopes: ["instagram_basic", "instagram_manage_insights"],
        credential_generation: 3,
      },
      {
        social_account_id: "acc-direct",
        user_id: "u1",
        platform: "instagram",
        login_kind: "direct",
        permission_read_state: "ok",
        granted_scopes: ["instagram_business_manage_insights"],
        credential_generation: 1,
      },
      {
        social_account_id: "acc-unknown",
        user_id: "u1",
        platform: "instagram",
        login_kind: "page_linked",
        permission_read_state: "unknown",
        granted_scopes: [],
        credential_generation: 1,
      },
      {
        social_account_id: "acc-noscope",
        user_id: "u1",
        platform: "instagram",
        login_kind: "page_linked",
        permission_read_state: "ok",
        granted_scopes: ["instagram_basic"],
        credential_generation: 1,
      },
      {
        social_account_id: "acc-inactive",
        user_id: "u1",
        platform: "instagram",
        login_kind: "page_linked",
        permission_read_state: "ok",
        granted_scopes: ["instagram_manage_insights"],
        credential_generation: 1,
      },
      {
        social_account_id: "acc-reauth",
        user_id: "u1",
        platform: "instagram",
        login_kind: "page_linked",
        permission_read_state: "ok",
        granted_scopes: ["instagram_manage_insights"],
        credential_generation: 1,
      },
    ],
  });

  const store = createCompetitorServiceStore({
    rpc: async () => ({ data: null, error: null }),
    reads,
  });

  const candidates = await store.listViewerCandidates({ userId: "u1" });

  assertEquals(candidates.length, 1);
  assertEquals(candidates[0]!.id, "acc-page");
  assertEquals(candidates[0]!.platform_user_id, "ig-page");
  assertEquals(candidates[0]!.access_token, SELECTOR_TOKEN_SENTINEL);
  assertEquals(candidates[0]!.is_active, true);
  assertEquals(candidates[0]!.needs_reauth, false);
  assertEquals(candidates[0]!.ig_auth_type, null);
  assertEquals(
    JSON.stringify(candidates[0]!.account_metadata),
    JSON.stringify({ granted_scopes: ["instagram_basic", "instagram_manage_insights"] }),
  );

  // The reads are owner-scoped and never ask for the browser-authored
  // account metadata.
  assertEquals(calls[0]!.table, "social_accounts");
  assertEquals(calls[0]!.filters.user_id, "u1");
  assertEquals(calls[0]!.filters.platform, "instagram");
  assertEquals(calls[1]!.table, "instagram_account_capabilities");
  assertEquals(calls[1]!.filters.user_id, "u1");
});

Deno.test("the protected credential is resolved with the generation that came with it", async () => {
  const rpc: CompetitorRpcCaller = async (name) => {
    if (name === "read_facebook_user_account_credential") {
      return {
        data: {
          found: true,
          social_account_id: "acc-page",
          platform: "instagram",
          credential_id: "cred-1",
          credential_kind: "facebook_user",
          token: "protected-token",
          token_expires_at: null,
          revision: 4,
          capability_generation: 3,
          connection_version: 1,
        },
        error: null,
      };
    }
    if (name === "read_instagram_account_capability") {
      return {
        data: {
          social_account_id: "acc-page",
          capability_present: true,
          login_kind: "page_linked",
          permission_read_state: "ok",
          scopes_authoritative: true,
          granted_scopes: ["instagram_manage_insights"],
          scopes_read_at: "2026-01-01T00:00:00Z",
          last_read_failed_at: null,
          last_read_error_code: null,
          credential_generation: 3,
          credential_updated_at: null,
          generation_reason: null,
          reconnected_at: null,
          has_protected_credential: true,
          updated_at: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc, reads });

  const credential = await store.resolveViewerCredential({
    userId: "u1",
    socialAccountId: "acc-page",
  });

  assertEquals(credential.token, "protected-token");
  assertEquals(credential.credentialId, "cred-1");
  assertEquals(credential.capabilityGeneration, 3);
});

Deno.test("a credential generation that moved between the reads is refused", async () => {
  const rpc: CompetitorRpcCaller = async (name) => {
    if (name === "read_facebook_user_account_credential") {
      return {
        data: {
          found: true,
          social_account_id: "acc-page",
          platform: "instagram",
          credential_id: "cred-1",
          credential_kind: "facebook_user",
          token: "protected-token",
          token_expires_at: null,
          revision: 4,
          capability_generation: 3,
          connection_version: 1,
        },
        error: null,
      };
    }
    return {
      data: {
        social_account_id: "acc-page",
        capability_present: true,
        login_kind: "page_linked",
        permission_read_state: "ok",
        scopes_authoritative: true,
        granted_scopes: ["instagram_manage_insights"],
        scopes_read_at: "2026-01-01T00:00:00Z",
        last_read_failed_at: null,
        last_read_error_code: null,
        // The connection was replaced between the two reads.
        credential_generation: 4,
        credential_updated_at: null,
        generation_reason: "reconnect",
        reconnected_at: "2026-10-29T00:00:00Z",
        has_protected_credential: true,
        updated_at: null,
      },
      error: null,
    };
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc, reads });

  const error = await assertRejects(
    () => store.resolveViewerCredential({ userId: "u1", socialAccountId: "acc-page" }),
    CompetitorStoreError,
  );

  assertEquals(error.failure, "stale_claim");
});

Deno.test("a direct login account is refused as a viewer credential", async () => {
  const rpc: CompetitorRpcCaller = async (name) => {
    if (name === "read_facebook_user_account_credential") {
      return {
        data: {
          found: true,
          social_account_id: "acc-direct",
          platform: "instagram",
          credential_id: "cred-2",
          credential_kind: "facebook_user",
          token: "protected-token",
          token_expires_at: null,
          revision: 1,
          capability_generation: 1,
          connection_version: 1,
        },
        error: null,
      };
    }
    return {
      data: {
        social_account_id: "acc-direct",
        capability_present: true,
        login_kind: "direct",
        permission_read_state: "ok",
        scopes_authoritative: true,
        granted_scopes: ["instagram_business_manage_insights"],
        scopes_read_at: "2026-01-01T00:00:00Z",
        last_read_failed_at: null,
        last_read_error_code: null,
        credential_generation: 1,
        credential_updated_at: null,
        generation_reason: null,
        reconnected_at: null,
        has_protected_credential: true,
        updated_at: null,
      },
      error: null,
    };
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc, reads });

  const error = await assertRejects(
    () => store.resolveViewerCredential({ userId: "u1", socialAccountId: "acc-direct" }),
    CompetitorStoreError,
  );

  assertEquals(error.failure, "read_failed");
});

Deno.test("an account with no protected credential is not an empty token", async () => {
  const rpc: CompetitorRpcCaller = async () => ({
    data: {
      found: false,
      social_account_id: "acc-page",
      platform: "instagram",
      credential_id: null,
      credential_kind: null,
      token: null,
      token_expires_at: null,
      revision: null,
      capability_generation: null,
      connection_version: null,
    },
    error: null,
  });

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc, reads });

  const error = await assertRejects(
    () => store.resolveViewerCredential({ userId: "u1", socialAccountId: "acc-page" }),
    CompetitorStoreError,
  );

  assertEquals(error.failure, "not_found");
});

Deno.test("the throttle bucket read returns the shared state or nothing", async () => {
  const { reads } = readPort({
    instagram_provider_throttle_buckets: {
      bucket_key: "k",
      usage_percent: 82,
      throttled_until: "2026-10-29T03:00:00Z",
    },
  });

  const store = createCompetitorServiceStore({
    rpc: async () => ({ data: null, error: null }),
    reads,
  });

  const bucket = await store.readThrottleBucket({ bucketKey: "k" });
  assertEquals(bucket?.usagePercent, 82);
  assertEquals(bucket?.throttledUntil, "2026-10-29T03:00:00Z");

  const { reads: emptyReads } = readPort();
  const emptyStore = createCompetitorServiceStore({
    rpc: async () => ({ data: null, error: null }),
    reads: emptyReads,
  });
  assertEquals(await emptyStore.readThrottleBucket({ bucketKey: "k" }), null);
});

Deno.test("a failed read is never an empty result", async () => {
  const store = createCompetitorServiceStore({
    rpc: async () => ({ data: null, error: { code: "42501", message: "denied" } }),
    reads: {
      async readOne() {
        return { data: null, error: { code: "42501" } };
      },
      async readMany() {
        return { data: [], error: { code: "42501" } };
      },
    },
  });

  const error = await assertRejects(
    () => store.readWatchlistTarget({ watchlistId: "c1", userId: "u1" }),
    CompetitorStoreError,
  );
  assertEquals(error.failure, "forbidden");

  const listError = await assertRejects(
    () => store.listViewerCandidates({ userId: "u1" }),
    CompetitorStoreError,
  );
  assertEquals(listError.failure, "forbidden");
});

// ---------------------------------------------------------------------------
// Receipts that are not exactly the accepted projection are indeterminate.
// ---------------------------------------------------------------------------

async function storeFailure(work: () => Promise<unknown>): Promise<string> {
  const error = await assertRejects(work, CompetitorStoreError);
  return error.failure;
}

Deno.test("a malformed status is never manufactured into 'none'", async () => {
  for (const data of [{}, { status: "none" }, { ...noJobStatus(), job_generation: 1 }]) {
    const store = createCompetitorOwnerStore(async () => ({ data, error: null }));
    assertEquals(
      await storeFailure(() => store.readCompetitorStatus({ watchlistId: WATCHLIST_ID, capturedOn: null })),
      "read_failed",
    );
  }

  const legitimate = createCompetitorOwnerStore(async () => ({ data: noJobStatus(), error: null }));
  const status = await legitimate.readCompetitorStatus({ watchlistId: WATCHLIST_ID, capturedOn: null });
  assertEquals(status.status, "none");
  assertEquals(status.pendingOperations, 0);
});

Deno.test("a status for another target or day is refused", async () => {
  const other = createCompetitorOwnerStore(async () => ({
    data: { ...noJobStatus(), target_id: JOB_ID },
    error: null,
  }));
  assertEquals(
    await storeFailure(() => other.readCompetitorStatus({ watchlistId: WATCHLIST_ID, capturedOn: null })),
    "read_failed",
  );
  const day = createCompetitorOwnerStore(async () => ({ data: noJobStatus(), error: null }));
  assertEquals(
    await storeFailure(() => day.readCompetitorStatus({ watchlistId: WATCHLIST_ID, capturedOn: "2026-10-28" })),
    "read_failed",
  );
});

Deno.test("a definitive SQLSTATE needs an own data descriptor first", async () => {
  let getterRuns = 0;
  const accessor = {} as Record<string, unknown>;
  Object.defineProperty(accessor, "data", { enumerable: true, get: () => (getterRuns += 1, null) });
  accessor.error = { code: "P0002" };

  for (const envelope of [{ error: { code: "P0002" } }, accessor]) {
    const store = createCompetitorOwnerStore(async () => envelope);
    assertEquals(
      await storeFailure(() => store.enqueueCompetitorJob({ watchlistId: WATCHLIST_ID, mode: "normal" })),
      "read_failed",
    );
  }
  assertEquals(getterRuns, 0);

  const definitive = createCompetitorOwnerStore(async () => ({ data: null, error: { code: "P0002" } }));
  assertEquals(
    await storeFailure(() => definitive.enqueueCompetitorJob({ watchlistId: WATCHLIST_ID, mode: "normal" })),
    "not_found",
  );
});

Deno.test("a result receipt that disagrees with the request is not success", async () => {
  const variants = [
    { ...V2_RECEIPT, job_id: WATCHLIST_ID },
    { ...V2_RECEIPT, job_generation: 2 },
    { ...V2_RECEIPT, written: 0 },
    { ...V2_RECEIPT, source: "apify" },
    { ...V2_RECEIPT, captured_at: null },
    { ...V2_RECEIPT, outcome: "retry" },
    { ...V2_RECEIPT, version: 1 },
    { ...V2_RECEIPT, version: null },
    null,
  ];
  for (const data of variants) {
    const { reads } = readPort();
    const store = createCompetitorServiceStore({ rpc: async () => ({ data, error: null }), reads });
    assertEquals(
      await storeFailure(() =>
        store.persistResult({ jobId: JOB_ID, claimToken: "t", jobGeneration: 1, payload: V2_PAYLOAD })
      ),
      "read_failed",
    );
  }

  const { reads } = readPort();
  const store = createCompetitorServiceStore({
    rpc: async () => ({ data: V2_RECEIPT, error: null }),
    reads,
  });
  const receipt = await store.persistResult({
    jobId: JOB_ID,
    claimToken: "t",
    jobGeneration: 1,
    payload: V2_PAYLOAD,
  });
  assertEquals(receipt.written, 1);
  assertEquals(receipt.coverage?.inventoryComplete, true);
  assertEquals(receipt.coverage?.orderingVerified, false);
});

Deno.test("a v1 receipt is never read as a versioned success", async () => {
  // The v1 receipt has no `version` key at all. It answers a different
  // question, so it can never be accepted as a v2 write.
  const v1 = {
    job_id: JOB_ID,
    job_generation: 1,
    outcome: "completed",
    source: "official",
    watchlist_id: WATCHLIST_ID,
    captured_on: "2026-10-29",
    written: 1,
    media_count: 0,
    captured_at: "2026-10-29T02:00:00+00:00",
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({ rpc: async () => ({ data: v1, error: null }), reads });
  assertEquals(
    await storeFailure(() =>
      store.persistResult({ jobId: JOB_ID, claimToken: "t", jobGeneration: 1, payload: V2_PAYLOAD })
    ),
    "read_failed",
  );
});

Deno.test("the coverage instants are compared as instants, not as text", async () => {
  // The database renders an instant in its own canonical form and the
  // collector submits it in its own. The same moment written the two ways
  // is the same moment; one second apart is not.
  const sameInstant = {
    ...V2_RECEIPT.coverage,
    capture_started_at: "2026-10-29T02:00:00+00:00",
    capture_ended_at: "2026-10-29T02:00:05+00:00",
  };

  const { reads } = readPort();
  const store = createCompetitorServiceStore({
    rpc: async () => ({ data: { ...V2_RECEIPT, coverage: sameInstant }, error: null }),
    reads,
  });
  const receipt = await store.persistResult({
    jobId: JOB_ID,
    claimToken: "t",
    jobGeneration: 1,
    payload: V2_PAYLOAD,
  });
  assertEquals(receipt.coverage?.inventoryComplete, true);

  const oneSecondOff = {
    ...V2_RECEIPT.coverage,
    capture_ended_at: "2026-10-29T02:00:06+00:00",
  };
  const { reads: otherReads } = readPort();
  const other = createCompetitorServiceStore({
    rpc: async () => ({ data: { ...V2_RECEIPT, coverage: oneSecondOff }, error: null }),
    reads: otherReads,
  });
  assertEquals(
    await storeFailure(() =>
      other.persistResult({ jobId: JOB_ID, claimToken: "t", jobGeneration: 1, payload: V2_PAYLOAD })
    ),
    "read_failed",
  );
});

Deno.test("a receipt whose stored coverage disagrees with the request is not success", async () => {
  const variants = [
    // The stored coverage belongs to another entry.
    { ...V2_RECEIPT.coverage, watchlist_id: "c1000000-0000-4000-8000-000000000099" },
    // The stored coverage belongs to another day.
    { ...V2_RECEIPT.coverage, captured_on: "2026-10-28" },
    // The stored coverage claims another source.
    { ...V2_RECEIPT.coverage, source: "apify" },
    // The stored coverage belongs to another revision.
    { ...V2_RECEIPT.coverage, job_generation: 2 },
    // The stored coverage reports different instants than the payload.
    { ...V2_RECEIPT.coverage, capture_started_at: "2026-10-29T01:00:00.000Z" },
    { ...V2_RECEIPT.coverage, oldest_returned_at: "2026-10-28T12:00:00.000Z" },
    // The stored coverage flipped a flag.
    { ...V2_RECEIPT.coverage, exhausted: false },
    { ...V2_RECEIPT.coverage, truncated: true },
    { ...V2_RECEIPT.coverage, ordering_verified: true },
    { ...V2_RECEIPT.coverage, cursor_present: true },
    // The stored coverage names a gap the payload did not.
    { ...V2_RECEIPT.coverage, gap_reason: "cursor_loop" },
    // The derived verdict does not follow the evidence.
    { ...V2_RECEIPT.coverage, inventory_complete: false },
    // A coverage that is not an object at all.
    "not-a-coverage",
    null,
  ];

  for (const coverage of variants) {
    const { reads } = readPort();
    const store = createCompetitorServiceStore({
      rpc: async () => ({ data: { ...V2_RECEIPT, coverage }, error: null }),
      reads,
    });
    assertEquals(
      await storeFailure(() =>
        store.persistResult({ jobId: JOB_ID, claimToken: "t", jobGeneration: 1, payload: V2_PAYLOAD })
      ),
      "read_failed",
    );
  }
});

Deno.test("a null or partial throttle receipt is not proof the backoff was stored", async () => {
  for (const data of [null, {}, { bucket_key: "k", usage_percent: 10, throttled_until: null }]) {
    const { reads } = readPort();
    const store = createCompetitorServiceStore({ rpc: async () => ({ data, error: null }), reads });
    assertEquals(
      await storeFailure(() =>
        store.recordThrottle({ bucketKey: "k", usagePercent: 10, throttledUntil: null })
      ),
      "read_failed",
    );
  }
  const { reads } = readPort();
  const parked = createCompetitorServiceStore({
    rpc: async () => ({
      data: { bucket_key: "k", usage_percent: 10, throttled_until: null, job_id: null },
      error: null,
    }),
    reads,
  });
  // A global receipt does not answer for a job-scoped park.
  assertEquals(
    await storeFailure(() =>
      parked.recordThrottle({
        bucketKey: "k",
        usagePercent: 10,
        throttledUntil: null,
        jobId: JOB_ID,
        claimToken: "t",
        jobGeneration: 1,
      })
    ),
    "read_failed",
  );
});

function noJobStatus(): Record<string, unknown> {
  return {
    target_kind: "competitor",
    target_id: WATCHLIST_ID,
    captured_on: "2026-10-29",
    status: "none",
    job_generation: 0,
    attempts: 0,
    due_at: null,
    next_retry_at: null,
    last_attempt_at: null,
    last_partial_at: null,
    last_success_at: null,
    reason_code: null,
    inventory: INVENTORY,
  };
}
