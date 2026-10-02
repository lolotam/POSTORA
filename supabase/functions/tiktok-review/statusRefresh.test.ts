import {
  assert,
  assertEquals,
  assertRejects,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import { readStatus } from "./statusRefresh.ts";
import type { AdminClient, DbResult, Dependencies, Query, Row } from "./context.ts";
import { ReviewError } from "./errors.ts";

const testUserId = "user-1111-1111";
const testSubmissionId = "sub-2222-2222";
const testPostId = "post-3333-3333";
const testAccountId = "acc-4444-4444";
const testPublishId = "tiktok-pub-9999";
const testDraftId = "draft-5555-5555";
const nowMs = 1727700000000;

type Call = { name: string; table?: string; args?: unknown[] };

function createStatusFixture(options: {
  submissionExists?: boolean;
  submissionState?: string;
  submissionUpdatedAt?: string;
  providerPublishId?: string | null;
  lastStatusCheckAt?: string | null;
  platformPost?: Row | null;
  tiktokStatusResponse?: unknown;
  claimSucceeds?: boolean;
  webhookEventsError?: unknown;
  reopenAllowed?: unknown;
} = {}) {
  const calls: Call[] = [];
  const rpcCalls: { name: string; params: Row }[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const logs: Array<{ event: string; level: string; context?: Record<string, unknown> }> = [];
  let currentPlatformPost: Row | null = options.platformPost ?? null;
  const submissionExists = options.submissionExists ?? true;

  const submissionRow: Row = {
    id: testSubmissionId,
    draft_id: testDraftId,
    post_id: testPostId,
    social_account_id: testAccountId,
    dispatch_state: options.submissionState ?? "publishing",
    provider_publish_id: options.providerPublishId !== undefined ? options.providerPublishId : testPublishId,
    last_status_check_at: options.lastStatusCheckAt ?? null,
    updated_at: options.submissionUpdatedAt ?? new Date(nowMs - 4 * 60 * 1000).toISOString(),
  };

  const postRow: Row = {
    id: testPostId,
    status: "pending",
    created_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
    posted_at: null,
    scheduled_at: null,
  };

  const accountRow: Row = {
    id: testAccountId,
    platform_user_id: "tiktok-open-id-123",
    platform_username: "@creator_handle",
    access_token: "tiktok-valid-access-token",
    account_metadata: {},
    avatar_url: null,
  };

  const admin: AdminClient = {
    from: (table: string) => {
      calls.push({ name: "from", table });
      let updatePayload: Row | null = null;

      const query: Query = {
        select: (cols: string) => {
          calls.push({ name: "select", table, args: [cols] });
          return query;
        },
        eq: (col: string, val: unknown) => {
          calls.push({ name: "eq", table, args: [col, val] });
          return query;
        },
        is: (col: string, val: null) => {
          calls.push({ name: "is", table, args: [col, val] });
          return query;
        },
        in: (col: string, vals: readonly string[]) => {
          calls.push({ name: "in", table, args: [col, vals] });
          return query;
        },
        order: (col: string, opts: { ascending: boolean }) => {
          calls.push({ name: "order", table, args: [col, opts] });
          return query;
        },
        limit: (cnt: number) => {
          calls.push({ name: "limit", table, args: [cnt] });
          return query;
        },
        update: (values: Row) => {
          updatePayload = values;
          calls.push({ name: "update", table, args: [values] });
          return query;
        },
        maybeSingle: () => {
          calls.push({ name: "maybeSingle", table });
          if (table === "tiktok_review_submissions") {
            if (!submissionExists) return Promise.resolve({ data: null, error: null });
            return Promise.resolve({ data: submissionRow, error: null });
          }
          if (table === "posts") {
            return Promise.resolve({ data: postRow, error: null });
          }
          if (table === "platform_posts") {
            return Promise.resolve({ data: currentPlatformPost, error: null });
          }
          if (table === "social_accounts") {
            return Promise.resolve({ data: accountRow, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve, reject) => {
          calls.push({ name: "then", table });
          let result: DbResult = { data: null, error: null };
          if (table === "tiktok_review_submissions") {
            if (updatePayload && "last_status_check_at" in updatePayload) {
              const claimSuccess = options.claimSucceeds ?? true;
              result = { data: claimSuccess ? [{ id: testSubmissionId }] : [], error: null };
            } else {
              result = { data: submissionExists ? [submissionRow] : [], error: null };
            }
          } else if (table === "platform_posts") {
            if (updatePayload !== null && currentPlatformPost) {
              currentPlatformPost = { ...currentPlatformPost, ...updatePayload };
            }
            result = { data: currentPlatformPost ? [currentPlatformPost] : [], error: null };
          } else if (table === "tiktok_webhook_events") {
            if (options.webhookEventsError) {
              result = { data: null, error: options.webhookEventsError };
            } else {
              result = { data: [], error: null };
            }
          }
          return Promise.resolve(result).then(resolve, reject);
        },
      };
      return query;
    },
    rpc: (name: string, params: Row) => {
      rpcCalls.push({ name, params });
      if (name === "tiktok_review_reopen_allowed") {
        return Promise.resolve({ data: "reopenAllowed" in options ? options.reopenAllowed : false, error: null });
      }
      if (name === "partner_settle_platform_post") {
        currentPlatformPost = {
          id: (params.p_platform_post_id as string) ?? "pp-settled-1",
          post_id: params.p_post_id,
          social_account_id: params.p_social_account_id,
          status: params.p_status,
          platform_post_url: params.p_provider_post_url,
          error_message: params.p_error_message,
          response_data: params.p_response_data ?? { tiktok_publish_id: testPublishId },
          created_at: new Date(nowMs - 10 * 60 * 1000).toISOString(),
          posted_at: params.p_status === "success" ? new Date(nowMs).toISOString() : null,
          social_accounts: {
            platform_user_id: "tiktok-open-id-123",
            platform_username: "@creator_handle",
            account_metadata: {},
          },
        };
      }
      return Promise.resolve({ data: { success: true }, error: null });
    },
  };

  const deps: Dependencies = {
    anonClient: () => { throw new Error("not needed in statusRefresh"); },
    admin,
    serviceRoleKey: "service-key",
    supabaseUrl: "https://api.postora.cloud",
    fetch: (url, init) => {
      fetchCalls.push({ url: String(url), init });
      const resp = options.tiktokStatusResponse ?? {
        data: { status: "PUBLISH_COMPLETE", publicaly_available_post_id: ["video-abc-123"] },
        error: { code: "ok" },
      };
      return Promise.resolve(new Response(JSON.stringify(resp), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }));
    },
    now: () => nowMs,
    log: (event: unknown) => {
      logs.push(event as { event: string; level: string; context?: Record<string, unknown> });
    },
  };

  return { deps, admin, calls, rpcCalls, fetchCalls, logs };
}

function stateOf(res: { body: { data?: unknown } }): unknown {
  return (res.body.data as Record<string, unknown> | undefined)?.state;
}

Deno.test("orphan reconciliation terminal paths settle post to success/failed and update state", async () => {
  const cases = [
    {
      name: "TikTok PUBLISH_COMPLETE settles post to success",
      response: {
        data: {
          status: "PUBLISH_COMPLETE",
          publicaly_available_post_id: ["video-abc-123"],
        },
        error: { code: "ok" },
      },
      expectedSettleStatus: "success",
      expectedProviderPostId: "video-abc-123",
      expectedProviderPostUrl: "https://www.tiktok.com/@creator_handle/video/video-abc-123",
      expectedErrorMessage: null,
      expectedState: "published",
    },
    {
      name: "TikTok FAILED settles post to failed with TikTok publish failed: <reason>",
      response: {
        data: {
          status: "FAILED",
          fail_reason: "spam_risk_user_banned_from_posting",
        },
        error: { code: "ok" },
      },
      expectedSettleStatus: "failed",
      expectedProviderPostId: null,
      expectedProviderPostUrl: null,
      expectedErrorMessage: "TikTok publish failed: spam_risk_user_banned_from_posting",
      expectedState: "failed",
    },
  ];

  for (const tc of cases) {
    const f = createStatusFixture({
      platformPost: null,
      submissionState: "publishing",
      providerPublishId: testPublishId,
      submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(), // 4 min old > 3 min
      claimSucceeds: true,
      tiktokStatusResponse: tc.response,
    });

    const res = await readStatus(f.deps, testUserId, testSubmissionId);
    assertEquals(res.status, 200);
    assertEquals(stateOf(res), tc.expectedState);

    // Exactly ONE TikTok status fetch call
    assertEquals(f.fetchCalls.length, 1);
    const statusFetch = f.fetchCalls[0];
    assert(statusFetch.url.includes("status/fetch"));
    assertEquals(JSON.parse(statusFetch.init?.body as string), {
      publish_id: testPublishId,
    });

    // partner_settle_platform_post called with expected arguments
    const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
    assertEquals(settleCalls.length, 1);
    assertEquals(settleCalls[0].params, {
      p_platform_post_id: null,
      p_post_id: testPostId,
      p_social_account_id: testAccountId,
      p_platform: "tiktok",
      p_status: tc.expectedSettleStatus,
      p_provider_post_id: tc.expectedProviderPostId,
      p_provider_post_url: tc.expectedProviderPostUrl,
      p_error_message: tc.expectedErrorMessage,
      p_response_data: { tiktok_publish_id: testPublishId, reconciled_by: "tiktok-review" },
    });

    // Claim builder assertions: is("last_status_check_at", null) and eq("user_id", testUserId)
    const claimIs = f.calls.find((c) => c.table === "tiktok_review_submissions" && c.name === "is");
    assert(claimIs, "Expected is('last_status_check_at', null)");
    assertEquals(claimIs.args, ["last_status_check_at", null]);
    const claimEq = f.calls.filter((c) => c.table === "tiktok_review_submissions" && c.name === "eq");
    const userFilter = claimEq.find((c) => c.args?.[0] === "user_id");
    assert(userFilter, "Expected eq('user_id', testUserId)");
    assertEquals(userFilter.args?.[1], testUserId);
  }
});

Deno.test("status-check claim builder uses eq when previous last_status_check_at is present", async () => {
  const previousCheckTime = new Date(nowMs - 30 * 1000).toISOString(); // 30s ago (> 15s)
  const f = createStatusFixture({
    platformPost: null,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
    lastStatusCheckAt: previousCheckTime,
    claimSucceeds: true,
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);

  const claimEqCalls = f.calls.filter(
    (c) => c.table === "tiktok_review_submissions" && c.name === "eq" && c.args?.[0] === "last_status_check_at",
  );
  assert(claimEqCalls.length > 0, "Expected eq('last_status_check_at', previousCheckTime)");
  assertEquals(claimEqCalls[0].args?.[1], previousCheckTime);
});

Deno.test("submission not owned or not found returns 404 with ZERO TikTok calls", async () => {
  const f = createStatusFixture({
    submissionExists: false,
  });

  const err = await assertRejects(
    () => readStatus(f.deps, testUserId, "non-existent-sub"),
    ReviewError,
  );
  assertEquals(err.status, 404);
  assertEquals(err.code, "NOT_FOUND");
  assertEquals(f.fetchCalls.length, 0);

  // Assert user_id filter was used when looking up submission
  const subLookupEq = f.calls.filter((c) => c.table === "tiktok_review_submissions" && c.name === "eq");
  const userFilter = subLookupEq.find((c) => c.args?.[0] === "user_id");
  assert(userFilter, "Expected eq('user_id', testUserId) on submission lookup");
  assertEquals(userFilter.args?.[1], testUserId);
});

Deno.test("orphan reconciliation: younger than 3 min makes ZERO TikTok calls and ZERO settle RPC calls", async () => {
  const f = createStatusFixture({
    platformPost: null,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    submissionUpdatedAt: new Date(nowMs - 2 * 60 * 1000).toISOString(), // 2 min old < 3 min
    claimSucceeds: true,
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);
  assertEquals(stateOf(res), "processing");

  // ZERO TikTok status fetch calls
  assertEquals(f.fetchCalls.length, 0);

  // ZERO settle RPC calls
  const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
  assertEquals(settleCalls.length, 0);
});

Deno.test("orphan reconciliation: non-terminal status makes NO settle RPC call", async () => {
  const f = createStatusFixture({
    platformPost: null,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
    claimSucceeds: true,
    tiktokStatusResponse: {
      data: {
        status: "PROCESSING_UPLOAD",
      },
      error: { code: "ok" },
    },
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);
  assertEquals(stateOf(res), "processing");

  // TikTok was queried
  assertEquals(f.fetchCalls.length, 1);

  // But NO settle RPC call because status is pending
  const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
  assertEquals(settleCalls.length, 0);
});

Deno.test("orphan reconciliation: claim failure makes ZERO TikTok calls and ZERO settle RPC calls", async () => {
  const f = createStatusFixture({
    platformPost: null,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
    claimSucceeds: false, // Concurrent check claimed it
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);
  assertEquals(stateOf(res), "processing");

  // ZERO TikTok status fetch calls
  assertEquals(f.fetchCalls.length, 0);

  // ZERO settle RPC calls
  const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
  assertEquals(settleCalls.length, 0);
});

Deno.test("non-orphan path: pending platform row applies pending webhook events, fetches status, and applies outcome", async () => {
  const initialPlatformPost: Row = {
    id: "pp-pending-1",
    post_id: testPostId,
    social_account_id: testAccountId,
    status: "pending",
    platform_post_url: null,
    error_message: null,
    response_data: { tiktok_publish_id: testPublishId },
    created_at: new Date(nowMs - 60 * 1000).toISOString(),
    posted_at: null,
    social_accounts: {
      platform_user_id: "tiktok-open-id-123",
      platform_username: "@creator_handle",
      account_metadata: {},
    },
  };

  const f = createStatusFixture({
    platformPost: initialPlatformPost,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    claimSucceeds: true,
    tiktokStatusResponse: {
      data: {
        status: "PUBLISH_COMPLETE",
        publicaly_available_post_id: ["video-non-orphan-999"],
      },
      error: { code: "ok" },
    },
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);

  // Status fetch was invoked
  assertEquals(f.fetchCalls.length, 1);
  const statusFetch = f.fetchCalls[0];
  assert(statusFetch.url.includes("status/fetch"));
  assertEquals(JSON.parse(statusFetch.init?.body as string), {
    publish_id: testPublishId,
  });

  // Settle RPC was called via applyTikTokPublishOutcome
  const settleCalls = f.rpcCalls.filter((c) => c.name === "partner_settle_platform_post");
  assertEquals(settleCalls.length, 1);
  assertEquals(settleCalls[0].params.p_status, "success");
  assertEquals(settleCalls[0].params.p_provider_post_id, "video-non-orphan-999");
  assertEquals(
    settleCalls[0].params.p_provider_post_url,
    "https://www.tiktok.com/@creator_handle/video/video-non-orphan-999",
  );

  assertEquals(stateOf(res), "published");
});

Deno.test("15-second throttle: fresh last_status_check_at makes ZERO status fetch calls", async () => {
  const f = createStatusFixture({
    platformPost: null,
    submissionState: "publishing",
    providerPublishId: testPublishId,
    submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
    lastStatusCheckAt: new Date(nowMs - 5 * 1000).toISOString(), // 5s ago < 15s
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);
  assertEquals(f.fetchCalls.length, 0);
  assertEquals(f.rpcCalls.filter((call) => call.name === "partner_settle_platform_post").length, 0);
});

Deno.test("orphan gate: dispatch_state dispatching/pending_dispatch or provider_publish_id null makes ZERO fetch calls", async () => {
  const cases = [
    { name: "dispatching state", state: "dispatching", publishId: testPublishId },
    { name: "pending_dispatch state", state: "pending_dispatch", publishId: testPublishId },
    { name: "null provider_publish_id", state: "publishing", publishId: null },
  ];

  for (const tc of cases) {
    const f = createStatusFixture({
      platformPost: null,
      submissionState: tc.state,
      providerPublishId: tc.publishId,
      submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(), // 4 min old > 3 min
    });

    const res = await readStatus(f.deps, testUserId, testSubmissionId);
    assertEquals(res.status, 200);
    assertEquals(f.fetchCalls.length, 0, `Expected 0 fetch calls for ${tc.name}`);
    assertEquals(
      f.rpcCalls.filter((call) => call.name === "partner_settle_platform_post").length,
      0,
      `Expected no settle call for ${tc.name}`,
    );
  }
});

Deno.test("orphan reconciliation: when applyPendingWebhookEvents throws after orphan settle, readStatus still returns 200 with settled state and writes sanitized log", async () => {
  const f = createStatusFixture({
    platformPost: null,
    submissionUpdatedAt: new Date(nowMs - 4 * 60 * 1000).toISOString(),
    webhookEventsError: { message: "database error reading webhook events" },
    tiktokStatusResponse: {
      data: {
        status: "PUBLISH_COMPLETE",
        publicaly_available_post_id: ["video-settled-456"],
      },
      error: { code: "ok" },
    },
  });

  const res = await readStatus(f.deps, testUserId, testSubmissionId);
  assertEquals(res.status, 200);
  assertEquals(stateOf(res), "published");
  assertEquals((res.body.data as Record<string, unknown>).postUrl, "https://www.tiktok.com/@creator_handle/video/video-settled-456");

  // Verify sanitized log entry was written
  const replayFailedLog = f.logs.find(
    (l) => l.event === "tiktok_review_provider_failed" && (l as Record<string, unknown>).code === "WEBHOOK_REPLAY_FAILED",
  );
  assert(replayFailedLog, "Expected WEBHOOK_REPLAY_FAILED log entry");
  assertEquals(replayFailedLog.level, "error");
  assertEquals((replayFailedLog as Record<string, unknown>).submission_id, testSubmissionId);
  assertEquals((replayFailedLog as Record<string, unknown>).action, "status");
  // Ensure no sensitive tokens appear in the logged data
  const logStr = JSON.stringify(replayFailedLog);
  assert(!logStr.includes("tiktok-valid-access-token"), "Access token must not appear in log");
});

Deno.test("status carries the database's reopen answer for the submission's draft", async () => {
  for (const allowed of [true, false]) {
    const f = createStatusFixture({ platformPost: null, submissionState: "needs_attention", reopenAllowed: allowed });
    const res = await readStatus(f.deps, testUserId, testSubmissionId);
    assertEquals((res.body.data as Record<string, unknown>).reopenable, allowed);
    const check = f.rpcCalls.find((call) => call.name === "tiktok_review_reopen_allowed");
    assertEquals(check?.params, { p_user_id: testUserId, p_draft_id: testDraftId });
  }
});

Deno.test("status fails rather than guess when the reopen check gives no answer", async () => {
  const f = createStatusFixture({ platformPost: null, submissionState: "needs_attention", reopenAllowed: null });
  await assertRejects(() => readStatus(f.deps, testUserId, testSubmissionId));
});
