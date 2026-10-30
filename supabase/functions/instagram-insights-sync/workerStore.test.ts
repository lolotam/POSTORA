/**
 * The service-role store of the OWNER collection worker.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the RPC contract: the accepted function names and the accepted
 *      argument names, one call per write;
 *   2. the strict receipts: a receipt that does not answer for the request
 *      that produced it is refused, and a refused receipt is a failure and
 *      never a success;
 *   3. the driver envelope: a missing `error` or `data` is a malformed
 *      envelope, and a driver error is classified by its SQLSTATE while its
 *      message is dropped;
 *   4. the protected credential: the token comes from the accepted adapter
 *      and there is no fallback to the account's own column;
 *   5. the owner-scoped reads: a row that names another owner is a contract
 *      violation and not a miss.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  createOwnerCollectionServiceStore,
  OwnerWorkerStoreError,
  type OwnerServiceRpcCaller,
} from "./workerStore.ts";
import {
  TEST_ACCOUNT_ID,
  TEST_CLAIM_TOKEN,
  TEST_CREDENTIAL_ID,
  TEST_JOB_ID,
  TEST_USER_ID,
  createClaimRow,
} from "./workerTestSupport.ts";

interface RecordedCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function createRpc(
  responder: (name: string, args: Record<string, unknown>) => unknown,
): { rpc: OwnerServiceRpcCaller; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const rpc: OwnerServiceRpcCaller = async (name, args) => {
    calls.push({ name, args });
    return await responder(name, args);
  };
  return { rpc, calls };
}

const CREDENTIAL_ROW = {
  found: true,
  social_account_id: TEST_ACCOUNT_ID,
  platform: "instagram",
  credential_id: TEST_CREDENTIAL_ID,
  credential_kind: "facebook_user",
  token: "the-secret-token",
  token_expires_at: "2026-11-28T12:00:00+00:00",
  revision: 3,
  capability_generation: 7,
  connection_version: 2,
};

const CAPABILITY_ROW = {
  social_account_id: TEST_ACCOUNT_ID,
  capability_present: true,
  login_kind: "page_linked",
  permission_read_state: "ok",
  scopes_authoritative: true,
  granted_scopes: ["instagram_basic", "instagram_manage_insights"],
  scopes_read_at: "2026-10-28T12:00:00+00:00",
  last_read_failed_at: null,
  last_read_error_code: null,
  credential_generation: 7,
  credential_updated_at: "2026-10-28T12:00:00+00:00",
  generation_reason: null,
  reconnected_at: null,
  has_protected_credential: true,
  updated_at: "2026-10-28T12:00:00+00:00",
};

/**
 * The direct credential answer.
 *
 * It is the accepted projection: eight keys, no refresh token and no
 * account metadata.
 */
const DIRECT_CREDENTIAL_ROW = {
  job_id: TEST_JOB_ID,
  user_id: TEST_USER_ID,
  social_account_id: TEST_ACCOUNT_ID,
  ig_user_id: "1784140001",
  login_kind: "direct",
  credential_generation: 7,
  access_token: "the-direct-token",
  token_expires_at: null,
};

function createStore(
  responder: (name: string, args: Record<string, unknown>) => unknown,
  reads: { rows?: Record<string, unknown> | null; mediaRows?: unknown[] } = {},
  writes: { stored?: boolean; fail?: boolean } = {},
) {
  const { rpc, calls } = createRpc(responder);
  const auditRows: Record<string, unknown>[] = [];
  const store = createOwnerCollectionServiceStore({
    rpc,
    reads: {
      async readOne(table, columns, filters) {
        calls.push({ name: `read:${table}`, args: { columns, ...filters } });
        return { data: reads.rows ?? null, error: null };
      },
      async readMany(table, columns, filters, idColumn, ids) {
        calls.push({
          name: `readMany:${table}`,
          args: { columns, ...filters, [idColumn]: [...ids] },
        });
        return { data: reads.mediaRows ?? [], error: null };
      },
    },
    writes: {
      async insertSystemLog(row) {
        auditRows.push({ ...row.metadata, source: row.source, level: row.level });
        if (writes.fail === true) throw new Error("the audit write failed");
        return writes.stored ?? true;
      },
    },
  });
  return { store, calls, auditRows };
}

// ---------------------------------------------------------------------------
// The claim
// ---------------------------------------------------------------------------

Deno.test("the claim calls the accepted function with the accepted arguments", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "claim_instagram_collection_jobs") {
      return { data: [createClaimRow()], error: null };
    }
    return { data: null, error: null };
  });

  const jobs = await store.claimOwnerJobs({ limit: 25 });

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "claim_instagram_collection_jobs");
  assertEquals(calls[0]!.args, { p_target_kind: "owner", p_limit: 25 });
  assertEquals(jobs.length, 1);
  assertEquals(jobs[0]!.jobId, TEST_JOB_ID);
  assertEquals(jobs[0]!.socialAccountId, TEST_ACCOUNT_ID);
  assertEquals(jobs[0]!.context.credentialGeneration, 7);
  assertEquals(jobs[0]!.context.loginKind, "page_linked");
});

Deno.test("a claimed row that is not the accepted projection is refused", async () => {
  const broken = createClaimRow();
  delete (broken as Record<string, unknown>).claim_token;

  const { store } = createStore(() => ({ data: [broken], error: null }));

  const error = await assertRejects(() => store.claimOwnerJobs({ limit: 25 }), OwnerWorkerStoreError);
  assertEquals(error.failure, "invalid_envelope");
});

Deno.test("a competitor job is refused by the owner worker", async () => {
  const { store } = createStore(() => ({
    data: [createClaimRow({ target_kind: "competitor" })],
    error: null,
  }));

  await assertRejects(() => store.claimOwnerJobs({ limit: 25 }), OwnerWorkerStoreError);
});

// ---------------------------------------------------------------------------
// The write receipts
// ---------------------------------------------------------------------------

Deno.test("a snapshot write sends the accepted arguments and checks the receipt", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "persist_instagram_collection_snapshot") {
      return {
        data: { job_id: TEST_JOB_ID, job_generation: 1, written: 1 },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  const receipt = await store.persistSnapshot({
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 1,
    payload: {
      kind: "owner_profile_observation",
      items: [{ observed_at: "2026-10-28T12:00:00.000Z", status: "ok", metrics: {} }],
    },
  });

  assertEquals(receipt.written, 1);
  assertEquals(calls[0]!.name, "persist_instagram_collection_snapshot");
  assertEquals(calls[0]!.args.p_job_id, TEST_JOB_ID);
  assertEquals(calls[0]!.args.p_claim_token, TEST_CLAIM_TOKEN);
  assertEquals(calls[0]!.args.p_job_generation, 1);
  assertEquals(
    (calls[0]!.args.p_payload as Record<string, unknown>).kind,
    "owner_profile_observation",
  );
});

Deno.test("a snapshot receipt that disagrees with the request is refused", async () => {
  for (
    const data of [
      { job_id: TEST_JOB_ID, job_generation: 1, written: 2 },
      { job_id: TEST_JOB_ID, job_generation: 2, written: 1 },
      { job_id: "01810009-0000-4000-8000-000000000009", job_generation: 1, written: 1 },
      { job_id: TEST_JOB_ID, job_generation: 1 },
      { job_id: TEST_JOB_ID, job_generation: 1, written: 1, extra: true },
    ]
  ) {
    const { store } = createStore(() => ({ data, error: null }));

    await assertRejects(
      () =>
        store.persistSnapshot({
          jobId: TEST_JOB_ID,
          claimToken: TEST_CLAIM_TOKEN,
          jobGeneration: 1,
          payload: { kind: "owner_media", items: [{ ig_media_id: "m1" }] },
        }),
      OwnerWorkerStoreError,
    );
  }
});

Deno.test("a snapshot write the database refused is a definitive per-job refusal", async () => {
  // The Facebook-login path writes through the same accepted function, and
  // the accepted fence refuses it with SQLSTATE 40001 when the lease or the
  // generation moved on. That refusal is `stale_claim`, and it is a
  // DEFINITIVE refusal of one job: the statement did not commit, so the
  // worker abandons that job alone instead of stopping the whole run.
  const { store } = createStore(() => ({
    data: null,
    error: { code: "40001", message: "secret sql text" },
  }));

  const error = await assertRejects(
    () =>
      store.persistSnapshot({
        jobId: TEST_JOB_ID,
        claimToken: TEST_CLAIM_TOKEN,
        jobGeneration: 1,
        payload: {
          kind: "owner_profile_observation",
          items: [{ observed_at: "2026-10-28T12:00:00.000Z", status: "ok", metrics: {} }],
        },
      }),
    OwnerWorkerStoreError,
  );

  assertEquals(error.failure, "stale_claim");
  assertEquals(error.sqlstate, "40001");
  assertEquals(error.message.includes("secret"), false);
});

Deno.test("the progress write sends the accepted inventory payload", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "record_instagram_collection_job_progress") {
      return {
        data: { job_id: TEST_JOB_ID, job_generation: 1, inventory: "recorded" },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  await store.recordProgress({
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 1,
    payload: {
      kind: "inventory",
      cursor: null,
      remaining_ids: [],
      pages_fetched: 2,
      oldest_returned_at: "2026-10-20T12:00:00.000Z",
      window_start: "2026-07-30",
      window_end: "2026-10-28",
      partial: false,
      truncated: false,
      window_covered: true,
      gap_reason: null,
    },
  });

  const payload = calls[0]!.args.p_payload as Record<string, unknown>;
  assertEquals(calls[0]!.name, "record_instagram_collection_job_progress");
  assertEquals(payload.kind, "inventory");
  assertEquals(payload.pages_fetched, 2);
  assertEquals(payload.window_covered, true);
  assertEquals(payload.gap_reason, null);
});

Deno.test("the progress write sends the accepted operations payload", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "record_instagram_collection_job_progress") {
      return {
        data: { job_id: TEST_JOB_ID, job_generation: 1, recorded: 2 },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  await store.recordProgress({
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 1,
    payload: {
      kind: "operations",
      items: [
        {
          operation_key: "account_day:2026-10-27:interactions",
          operation_kind: "account_day",
          state: "pending",
          provider_date: "2026-10-27",
          query_kind: "interactions",
        },
        {
          operation_key: "account_day:2026-10-26:interactions",
          operation_kind: "account_day",
          state: "pending",
          provider_date: "2026-10-26",
          query_kind: "interactions",
        },
      ],
    },
  });

  const payload = calls[0]!.args.p_payload as Record<string, unknown>;
  assertEquals(calls[0]!.name, "record_instagram_collection_job_progress");
  assertEquals(payload.kind, "operations");
  assertEquals((payload.items as unknown[]).length, 2);
  assertEquals(
    (payload.items as Array<Record<string, unknown>>)[0]!.operation_key,
    "account_day:2026-10-27:interactions",
  );
  assertEquals(
    (payload.items as Array<Record<string, unknown>>)[0]!.provider_date,
    "2026-10-27",
  );
  assertEquals(
    (payload.items as Array<Record<string, unknown>>)[0]!.state,
    "pending",
  );
});

Deno.test("a completion sends the accepted outcome and checks the receipt", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "complete_instagram_collection_job") {
      return {
        data: {
          job_id: TEST_JOB_ID,
          job_generation: 1,
          status: "retry",
          outcome: "retry",
          reason_code: "token_invalid",
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  const receipt = await store.completeJob({
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 1,
    outcome: "retry",
    reasonCode: "token_invalid",
  });

  assertEquals(receipt.status, "retry");
  assertEquals(calls[0]!.args.p_outcome, "retry");
  assertEquals(calls[0]!.args.p_reason_code, "token_invalid");
});

Deno.test("a completion receipt with another outcome or another reason is refused", async () => {
  for (
    const data of [
      {
        job_id: TEST_JOB_ID,
        job_generation: 1,
        status: "completed",
        outcome: "completed",
        reason_code: null,
      },
      {
        job_id: TEST_JOB_ID,
        job_generation: 1,
        status: "retry",
        outcome: "retry",
        reason_code: "provider_error",
      },
    ]
  ) {
    const { store } = createStore(() => ({ data, error: null }));

    await assertRejects(
      () =>
        store.completeJob({
          jobId: TEST_JOB_ID,
          claimToken: TEST_CLAIM_TOKEN,
          jobGeneration: 1,
          outcome: "retry",
          reasonCode: "token_invalid",
        }),
      OwnerWorkerStoreError,
    );
  }
});

Deno.test("a job-scoped throttle is bound to the request and to the parked job", async () => {
  const bucketKey = "a".repeat(64);
  const { store, calls } = createStore((name) => {
    if (name === "record_instagram_provider_throttle") {
      return {
        data: {
          bucket_key: bucketKey,
          usage_percent: 90,
          throttled_until: "2026-10-28T12:15:00.000Z",
          job_id: TEST_JOB_ID,
          status: "retry",
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  await store.recordThrottle({
    bucketKey,
    usagePercent: 90,
    throttledUntil: "2026-10-28T12:15:00.000Z",
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 1,
  });

  assertEquals(calls[0]!.name, "record_instagram_provider_throttle");
  assertEquals(calls[0]!.args.p_bucket_key, bucketKey);
  assertEquals(calls[0]!.args.p_usage_percent, 90);
  assertEquals(calls[0]!.args.p_throttled_until, "2026-10-28T12:15:00.000Z");
  assertEquals(calls[0]!.args.p_job_id, TEST_JOB_ID);
  assertEquals(calls[0]!.args.p_claim_token, TEST_CLAIM_TOKEN);
  assertEquals(calls[0]!.args.p_job_generation, 1);
});

Deno.test("a throttle receipt that does not report the parked job is refused", async () => {
  const bucketKey = "b".repeat(64);
  const { store } = createStore(() => ({
    data: {
      bucket_key: bucketKey,
      usage_percent: 90,
      throttled_until: "2026-10-28T12:15:00.000Z",
      job_id: TEST_JOB_ID,
    },
    error: null,
  }));

  await assertRejects(
    () =>
      store.recordThrottle({
        bucketKey,
        usagePercent: 90,
        throttledUntil: "2026-10-28T12:15:00.000Z",
        jobId: TEST_JOB_ID,
        claimToken: TEST_CLAIM_TOKEN,
        jobGeneration: 1,
      }),
    OwnerWorkerStoreError,
  );
});

// ---------------------------------------------------------------------------
// The driver envelope
// ---------------------------------------------------------------------------

Deno.test("a malformed driver envelope is a failure, never a success", async () => {
  for (
    const envelope of [
      { data: [] },
      { error: null },
      Object.assign(Object.create({ error: null }), { data: [] }),
      "not-an-envelope",
      42,
    ]
  ) {
    const { store } = createStore(() => envelope);

    const error = await assertRejects(
      () => store.claimOwnerJobs({ limit: 25 }),
      OwnerWorkerStoreError,
    );
    assertEquals(error.failure, "invalid_envelope");
  }
});

Deno.test("an error that is not an explicit null is never a completed read", async () => {
  for (const value of [undefined, false, 0, ""]) {
    const { store } = createStore(() => ({ data: [], error: value }));

    const error = await assertRejects(
      () => store.claimOwnerJobs({ limit: 25 }),
      OwnerWorkerStoreError,
    );
    assertEquals(error.failure, "rpc_failed", String(value));
  }
});

Deno.test("a driver error is classified by its SQLSTATE and its message is dropped", async () => {
  const cases: Array<[string, string]> = [
    ["42501", "forbidden"],
    ["P0002", "not_found"],
    ["40001", "stale_claim"],
    ["22023", "invalid"],
    ["PGRST202", "schema_unavailable"],
    ["57014", "rpc_failed"],
  ];

  for (const [sqlstate, failure] of cases) {
    const { store } = createStore(() => ({
      data: null,
      error: { code: sqlstate, message: "secret sql text" },
    }));

    const error = await assertRejects(
      () => store.claimOwnerJobs({ limit: 25 }),
      OwnerWorkerStoreError,
    );
    assertEquals(error.failure, failure, sqlstate);
    assertEquals(error.sqlstate, sqlstate);
    assertEquals(error.message.includes("secret"), false);
  }
});

// ---------------------------------------------------------------------------
// The direct credential
// ---------------------------------------------------------------------------

Deno.test("the direct credential is read through the fenced reader and bound to the request", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "read_instagram_direct_collection_credential") {
      return { data: DIRECT_CREDENTIAL_ROW, error: null };
    }
    return { data: null, error: null };
  });

  const credential = await store.resolveDirectOwnerCredential({
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 3,
    expectedCredentialGeneration: 7,
    socialAccountId: TEST_ACCOUNT_ID,
  });

  assertEquals(credential.accessToken, "the-direct-token");
  assertEquals(credential.igUserId, "1784140001");
  assertEquals(credential.loginKind, "direct");
  assertEquals(credential.credentialGeneration, 7);
  assertEquals(credential.tokenExpiresAt, null);

  // The call names the accepted function and its accepted arguments, and it
  // carries NO account or owner selector: the database derives the target
  // from the fenced job.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "read_instagram_direct_collection_credential");
  assertEquals(calls[0]!.args, {
    p_job_id: TEST_JOB_ID,
    p_claim_token: TEST_CLAIM_TOKEN,
    p_job_generation: 3,
    p_expected_credential_generation: 7,
  });
});

Deno.test("a direct receipt that does not answer for the request is indeterminate", async () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ["another job", { ...DIRECT_CREDENTIAL_ROW, job_id: TEST_CLAIM_TOKEN }],
    ["another account", { ...DIRECT_CREDENTIAL_ROW, social_account_id: TEST_CREDENTIAL_ID }],
    ["another generation", { ...DIRECT_CREDENTIAL_ROW, credential_generation: 8 }],
    ["another login kind", { ...DIRECT_CREDENTIAL_ROW, login_kind: "page_linked" }],
    ["an empty token", { ...DIRECT_CREDENTIAL_ROW, access_token: "" }],
    ["a missing token", { ...DIRECT_CREDENTIAL_ROW, access_token: null }],
    ["a refresh token", { ...DIRECT_CREDENTIAL_ROW, refresh_token: "the-refresh-token" }],
    ["an extra key", { ...DIRECT_CREDENTIAL_ROW, account_metadata: {} }],
    ["a malformed expiry", { ...DIRECT_CREDENTIAL_ROW, token_expires_at: "not-a-timestamp" }],
  ];

  for (const [label, row] of cases) {
    const { store } = createStore((name) => {
      if (name === "read_instagram_direct_collection_credential") {
        return { data: row, error: null };
      }
      return { data: null, error: null };
    });

    const error = await assertRejects(
      () =>
        store.resolveDirectOwnerCredential({
          jobId: TEST_JOB_ID,
          claimToken: TEST_CLAIM_TOKEN,
          jobGeneration: 3,
          expectedCredentialGeneration: 7,
          socialAccountId: TEST_ACCOUNT_ID,
        }),
      OwnerWorkerStoreError,
    );
    assertEquals(error.failure, "invalid_envelope", label);
  }
});

Deno.test("a direct refusal is classified by its SQLSTATE and its message is dropped", async () => {
  const cases: Array<[string, string]> = [
    ["IDC03", "credential_changed"],
    ["IDC04", "credential_changed"],
    ["IDC05", "credential_missing"],
    ["IDC01", "invalid"],
    ["IDC02", "invalid"],
    ["40001", "credential_changed"],
    ["42501", "forbidden"],
    ["PGRST202", "schema_unavailable"],
    ["57014", "rpc_failed"],
  ];

  for (const [sqlstate, failure] of cases) {
    const { store } = createStore(() => ({
      data: null,
      error: { code: sqlstate, message: "secret sql text" },
    }));

    const error = await assertRejects(
      () =>
        store.resolveDirectOwnerCredential({
          jobId: TEST_JOB_ID,
          claimToken: TEST_CLAIM_TOKEN,
          jobGeneration: 3,
          expectedCredentialGeneration: 7,
          socialAccountId: TEST_ACCOUNT_ID,
        }),
      OwnerWorkerStoreError,
    );
    assertEquals(error.failure, failure, sqlstate);
    assertEquals(error.sqlstate, sqlstate);
    assertEquals(error.message.includes("secret"), false);
  }
});

// ---------------------------------------------------------------------------
// The protected credential
// ---------------------------------------------------------------------------

Deno.test("the credential comes from the accepted adapters and never from the account", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "read_facebook_user_account_credential") {
      return { data: CREDENTIAL_ROW, error: null };
    }
    if (name === "read_instagram_account_capability") {
      return { data: CAPABILITY_ROW, error: null };
    }
    return { data: null, error: null };
  });

  const credential = await store.resolveOwnerCredential({
    userId: TEST_USER_ID,
    socialAccountId: TEST_ACCOUNT_ID,
  });

  assertEquals(credential.token, "the-secret-token");
  assertEquals(credential.credentialId, TEST_CREDENTIAL_ID);
  assertEquals(credential.capabilityGeneration, 7);

  // The credential is read on its own: the trusted capability has its own
  // read, so a direct-login account is decided before the credential.
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "read_facebook_user_account_credential");
  assertEquals(calls[0]!.args, {
    p_user_id: TEST_USER_ID,
    p_social_account_id: TEST_ACCOUNT_ID,
  });
});

Deno.test("the trusted capability is read on its own and names the login kind", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "read_instagram_account_capability") {
      return { data: CAPABILITY_ROW, error: null };
    }
    return { data: null, error: null };
  });

  const capability = await store.readOwnerCapability({
    userId: TEST_USER_ID,
    socialAccountId: TEST_ACCOUNT_ID,
  });

  assertEquals(capability.loginKind, "page_linked");
  assertEquals(capability.credentialGeneration, 7);
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "read_instagram_account_capability");
  assertEquals(calls[0]!.args, {
    p_user_id: TEST_USER_ID,
    p_social_account_id: TEST_ACCOUNT_ID,
  });
});

Deno.test("a capability without a known login kind is refused", async () => {
  const { store } = createStore((name) => {
    if (name === "read_instagram_account_capability") {
      return { data: { ...CAPABILITY_ROW, login_kind: "carrier_pigeon" }, error: null };
    }
    return { data: null, error: null };
  });

  const error = await assertRejects(
    () =>
      store.readOwnerCapability({
        userId: TEST_USER_ID,
        socialAccountId: TEST_ACCOUNT_ID,
      }),
    OwnerWorkerStoreError,
  );

  // The shared capability adapter refuses the shape before this store sees
  // it, so the read is a failure and never a capability.
  assertEquals(error.failure, "rpc_failed");
});

Deno.test("the media inventory is read back for the account and the capture day", async () => {
  const { store, calls } = createStore(() => ({ data: null, error: null }), {
    mediaRows: [
      {
        ig_media_id: "media-1",
        media_product_type: "FEED",
        media_type: "IMAGE",
        published_at: "2026-10-20T12:00:00+00:00",
        like_count_public: 55,
        comments_count_public: 3,
        permalink: "https://instagram.com/p/1",
        caption: "the caption",
        thumbnail_url: null,
        status: "ok",
        views: 200,
        reach: 100,
        likes: 55,
        comments: 3,
        saved: null,
        shares: null,
        total_interactions: 58,
        follows: null,
        profile_visits: null,
        replies: null,
        ig_reels_avg_watch_time_ms: null,
      },
    ],
  });

  const rows = await store.readOwnerMediaInventory({
    socialAccountId: TEST_ACCOUNT_ID,
    capturedOn: "2026-10-28",
    mediaIds: ["media-1"],
  });

  assertEquals(rows.length, 1);
  assertEquals(rows[0]!.igMediaId, "media-1");
  assertEquals(rows[0]!.publishedAt, "2026-10-20T12:00:00+00:00");
  assertEquals(rows[0]!.likeCountPublic, 55);
  assertEquals(rows[0]!.commentsCountPublic, 3);
  assertEquals(rows[0]!.permalink, "https://instagram.com/p/1");

  // The insight metrics this capture day already stores are read back, so
  // an inventory write can carry them over instead of nulling them.
  assertEquals(rows[0]!.status, "ok");
  assertEquals(rows[0]!.views, 200);
  assertEquals(rows[0]!.reach, 100);
  assertEquals(rows[0]!.totalInteractions, 58);
  assertEquals(rows[0]!.saved, null);
  assertEquals(rows[0]!.igReelsAvgWatchTimeMs, null);

  assertEquals(calls[0]!.name, "readMany:ig_media_insight_snapshots");
  assertEquals(calls[0]!.args.social_account_id, TEST_ACCOUNT_ID);
  assertEquals(calls[0]!.args.captured_on, "2026-10-28");
  assertEquals(calls[0]!.args.ig_media_id, ["media-1"]);
});

Deno.test("an empty media queue is not read at all", async () => {
  const { store, calls } = createStore(() => ({ data: null, error: null }));

  const rows = await store.readOwnerMediaInventory({
    socialAccountId: TEST_ACCOUNT_ID,
    capturedOn: "2026-10-28",
    mediaIds: [],
  });

  assertEquals(rows, []);
  assertEquals(calls.length, 0);
});

Deno.test("an account without a protected credential is refused, not given an empty token", async () => {
  const { store } = createStore((name) => {
    if (name === "read_facebook_user_account_credential") {
      return {
        data: {
          ...CREDENTIAL_ROW,
          found: false,
          credential_id: null,
          credential_kind: null,
          token: null,
          revision: null,
        },
        error: null,
      };
    }
    return { data: null, error: null };
  });

  const error = await assertRejects(
    () =>
      store.resolveOwnerCredential({
        userId: TEST_USER_ID,
        socialAccountId: TEST_ACCOUNT_ID,
      }),
    OwnerWorkerStoreError,
  );

  assertEquals(error.failure, "credential_missing");
});

Deno.test("the credential reports the generation it was read at", async () => {
  const { store } = createStore((name) => {
    if (name === "read_facebook_user_account_credential") {
      return { data: { ...CREDENTIAL_ROW, capability_generation: 8 }, error: null };
    }
    return { data: null, error: null };
  });

  const credential = await store.resolveOwnerCredential({
    userId: TEST_USER_ID,
    socialAccountId: TEST_ACCOUNT_ID,
  });

  // The generation is reported, not judged here: the worker compares it
  // with the trusted capability and with the captured context before it
  // spends a provider call.
  assertEquals(credential.capabilityGeneration, 8);
});

// ---------------------------------------------------------------------------
// The owner-scoped reads
// ---------------------------------------------------------------------------

Deno.test("the target read is owner-scoped and a foreign row is a contract violation", async () => {
  const { store, calls } = createStore(() => ({ data: null, error: null }), {
    rows: {
      id: TEST_ACCOUNT_ID,
      user_id: TEST_USER_ID,
      platform: "instagram",
      platform_user_id: "1784140001",
      is_active: true,
      needs_reauth: false,
    },
  });

  const target = await store.readOwnerTarget({
    socialAccountId: TEST_ACCOUNT_ID,
    userId: TEST_USER_ID,
  });

  assertEquals(target?.platformUserId, "1784140001");
  assertEquals(calls[0]!.name, "read:social_accounts");
  assertEquals(calls[0]!.args.id, TEST_ACCOUNT_ID);
  assertEquals(calls[0]!.args.user_id, TEST_USER_ID);
  assertEquals(calls[0]!.args.platform, "instagram");

  const { store: foreign } = createStore(() => ({ data: null, error: null }), {
    rows: {
      id: TEST_ACCOUNT_ID,
      user_id: "01810099-0000-4000-8000-000000000099",
      platform: "instagram",
      platform_user_id: "1784140001",
      is_active: true,
      needs_reauth: false,
    },
  });

  await assertRejects(
    () =>
      foreign.readOwnerTarget({
        socialAccountId: TEST_ACCOUNT_ID,
        userId: TEST_USER_ID,
      }),
    OwnerWorkerStoreError,
  );
});

Deno.test("a missing target is null, not a failure", async () => {
  const { store } = createStore(() => ({ data: null, error: null }), { rows: null });

  const target = await store.readOwnerTarget({
    socialAccountId: TEST_ACCOUNT_ID,
    userId: TEST_USER_ID,
  });

  assertEquals(target, null);
});

Deno.test("no error text ever carries a secret", async () => {
  const { store } = createStore(() => ({
    data: null,
    error: { code: "42501", message: "permission denied for schema secret_table" },
  }));

  const error = await assertRejects(
    () => store.claimOwnerJobs({ limit: 25 }),
    OwnerWorkerStoreError,
  );

  assertEquals(error.message.includes("secret_table"), false);
  assertStringIncludes(error.message, "could not complete");
  assert(error instanceof OwnerWorkerStoreError);
});

// ---------------------------------------------------------------------------
// The provider permit
// ---------------------------------------------------------------------------

/** The granted permit of the accepted projection. */
const PERMIT_ALLOWED_ROW = {
  allowed: true,
  job_id: TEST_JOB_ID,
  target_kind: "owner",
  target_id: TEST_ACCOUNT_ID,
  viewer_social_account_id: TEST_ACCOUNT_ID,
  job_generation: 3,
  credential_generation: 7,
  policy_fingerprint: "a".repeat(64),
};

function permitRequest() {
  return {
    jobId: TEST_JOB_ID,
    claimToken: TEST_CLAIM_TOKEN,
    jobGeneration: 3,
  };
}

Deno.test("the permit call sends the accepted arguments and names nothing else", async () => {
  const { store, calls } = createStore((name) => {
    if (name === "authorize_instagram_collection_provider_call") {
      return { data: PERMIT_ALLOWED_ROW, error: null };
    }
    return { data: null, error: null };
  });

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "allowed");
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "authorize_instagram_collection_provider_call");
  assertEquals(calls[0]!.args, {
    p_job_id: TEST_JOB_ID,
    p_claim_token: TEST_CLAIM_TOKEN,
    p_job_generation: 3,
  });
});

Deno.test("a refused permit is a refusal and the adapter writes no audit row", async () => {
  const { store, auditRows } = createStore(() => ({
    data: { allowed: false, reason_code: "collection_not_eligible" },
    error: null,
  }));

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "refused");
  assertEquals(decision.kind === "refused" ? decision.reasonCode : null,
    "collection_not_eligible");
  // The accepted SQL audits a normal refusal in the same committed
  // transaction, so the adapter writes nothing.
  assertEquals(auditRows.length, 0);
});

Deno.test("a permit that names another job is unavailable, never permission", async () => {
  const { store, auditRows } = createStore(() => ({
    data: { ...PERMIT_ALLOWED_ROW, job_id: "01810099-0000-4000-8000-000000000099" },
    error: null,
  }));

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0]!.event, "collection_provider_call_refused");
  assertEquals(auditRows[0]!.reason_code, "malformed_envelope");
});

Deno.test("a permit with an extra key is unavailable, never permission", async () => {
  const { store } = createStore(() => ({
    data: { ...PERMIT_ALLOWED_ROW, access_token: "a-secret" },
    error: null,
  }));

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
});

Deno.test("an unknown refusal reason is unavailable, never permission", async () => {
  const { store } = createStore(() => ({
    data: { allowed: false, reason_code: "everything_is_fine" },
    error: null,
  }));

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
});

Deno.test("a permit that cannot be read is audited in a separate bounded call", async () => {
  const { store, auditRows } = createStore(() => {
    throw new Error("the connection was lost");
  });

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
  assertEquals(decision.kind === "unavailable" ? decision.reasonCode : null,
    "permit_read_failed");
  assertEquals(decision.kind === "unavailable" ? decision.auditStored : null, true);
  assertEquals(auditRows.length, 1);
  assertEquals(auditRows[0]!.reason_code, "permit_read_failed");
  assertEquals(auditRows[0]!.job_id, TEST_JOB_ID);
});

Deno.test("an audit that does not commit is reported as a failure, never as a stored row", async () => {
  const { store, auditRows } = createStore(() => {
    throw new Error("the connection was lost");
  }, {}, { stored: false });

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
  assertEquals(decision.kind === "unavailable" ? decision.auditStored : null, false);
  assertEquals(auditRows.length, 1);
});

Deno.test("the rollout schema that is not deployed makes the gate unavailable", async () => {
  const { store } = createStore(() => ({
    data: null,
    error: { code: "PGRST202", message: "function does not exist" },
  }));

  const decision = await store.authorizeProviderCall(permitRequest());

  assertEquals(decision.kind, "unavailable");
  assertEquals(decision.kind === "unavailable" ? decision.reasonCode : null,
    "schema_unavailable");
});

Deno.test("the audit row of a refusal never carries a token or a claim token", async () => {
  const { store, auditRows } = createStore(() => {
    throw new Error("the connection was lost");
  });

  await store.authorizeProviderCall(permitRequest());

  const serialized = JSON.stringify(auditRows);
  assertEquals(serialized.includes(TEST_CLAIM_TOKEN), false);
  assertEquals(serialized.includes("access_token"), false);
});
