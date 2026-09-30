import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type AdminClient,
  type DbResult,
  type Dependencies,
  handleRequest,
  type LogEvent,
  type Query,
} from "./handler.ts";

const testUserId = "11111111-1111-4111-8111-111111111111";
const testAccountId = "22222222-2222-4222-8222-222222222222";
const testDraftId = "33333333-3333-4333-8333-333333333333";
const testMediaId = "44444444-4444-4444-8444-444444444444";
const testPostId = "55555555-5555-4555-8555-555555555555";
const testSubmissionId = "66666666-6666-4666-8666-666666666666";
const testRequestId = "77777777-7777-4777-8777-777777777777";
const fakeServiceKey = "service-role-secret-key-12345";
const fakeTiktokToken = "tiktok-oauth-token-secret-abcdef";

const defaultSettings = {
  privacy: "PUBLIC_TO_EVERYONE",
  allowComment: true,
  allowDuet: true,
  allowStitch: true,
  disclose: false,
  yourBrand: false,
  brandedContent: false,
  aiGenerated: false,
};

const defaultDraftRow = {
  id: testDraftId,
  social_account_id: testAccountId,
  revision: 1,
  state: "pending_review",
  caption: "Draft caption for TikTok",
  media_file_id: testMediaId,
  media_duration_sec: 30,
  settings: defaultSettings,
  rejection_reason: null,
  updated_at: "2026-10-02T12:00:00.000Z",
};

const defaultAccountRow = {
  id: testAccountId,
  platform_user_id: "tiktok-open-user-id",
  platform_username: "creator_test",
  access_token: fakeTiktokToken,
  account_metadata: {},
  avatar_url: "https://avatar.test/pic.png",
};

const defaultCreatorApiResponse = {
  data: {
    creator_username: "creator_test",
    creator_nickname: "Creator Test",
    creator_avatar_url: "https://avatar.test/pic.png",
    privacy_level_options: ["PUBLIC_TO_EVERYONE", "MUTUAL_FOLLOW_FRIENDS", "SELF_ONLY"],
    max_video_post_duration_sec: 600,
    comment_disabled: false,
    duet_disabled: false,
    stitch_disabled: false,
  },
  error: { code: "ok" },
};

type Call = { name: string; table?: string; args?: unknown[] };

function createFixture(options: {
  userId?: string;
  tableResults?: Record<string, DbResult>;
  rpcResults?: Record<string, DbResult>;
  fetchHandler?: (url: string, init?: RequestInit) => Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  const logs: LogEvent[] = [];
  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const userId = options.userId ?? testUserId;

  const admin: AdminClient = {
    from: (table: string) => {
      calls.push({ name: "from", table });
      const filters: Record<string, unknown> = {};

      const query: Query = {
        select: (cols: string) => {
          calls.push({ name: "select", table, args: [cols] });
          return query;
        },
        eq: (col: string, val: unknown) => {
          filters[col] = val;
          calls.push({ name: "eq", table, args: [col, val] });
          return query;
        },
        is: (col: string, val: null) => {
          filters[col] = val;
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
        update: (values: Record<string, unknown>) => {
          calls.push({ name: "update", table, args: [values] });
          return query;
        },
        maybeSingle: () => {
          calls.push({ name: "maybeSingle", table });
          if (options.tableResults && table in options.tableResults) {
            return Promise.resolve(options.tableResults[table]);
          }
          if (table === "tiktok_review_drafts") {
            return Promise.resolve({ data: defaultDraftRow, error: null });
          }
          if (table === "social_accounts") {
            return Promise.resolve({ data: defaultAccountRow, error: null });
          }
          if (table === "media_files") {
            return Promise.resolve({ data: { id: testMediaId, metadata: { duration: 30 } }, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then: (resolve, reject) => {
          calls.push({ name: "then", table });
          let res: DbResult;
          if (options.tableResults && table in options.tableResults) {
            res = options.tableResults[table];
          } else if (table === "tiktok_review_drafts") {
            res = { data: [defaultDraftRow], error: null };
          } else if (table === "tiktok_review_submissions") {
            res = { data: [], error: null };
          } else {
            res = { data: null, error: null };
          }
          return Promise.resolve(res).then(resolve, reject);
        },
      };
      return query;
    },
    rpc: (name: string, params: Record<string, unknown>) => {
      calls.push({ name: `rpc:${name}`, args: [params] });
      if (options.rpcResults && name in options.rpcResults) {
        return Promise.resolve(options.rpcResults[name]);
      }
      if (name === "tiktok_review_save_draft") {
        return Promise.resolve({
          data: { ...defaultDraftRow, revision: (Number(params.p_expected_revision) || 1) + 1 },
          error: null,
        });
      }
      if (name === "tiktok_review_submit") {
        return Promise.resolve({
          data: {
            submission_id: testSubmissionId,
            post_id: testPostId,
            mode: params.p_mode ?? "now",
            created: true,
          },
          error: null,
        });
      }
      if (name === "tiktok_review_set_dispatch_state") {
        return Promise.resolve({ data: true, error: null });
      }
      return Promise.resolve({ data: defaultDraftRow, error: null });
    },
  };

  const defaultFetch = (url: string, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({ url, init });
    if (options.fetchHandler) {
      return options.fetchHandler(url, init);
    }
    if (url.includes("creator_info")) {
      return Promise.resolve(
        new Response(JSON.stringify(defaultCreatorApiResponse), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
      );
    }
    if (url.includes("process-post")) {
      return Promise.resolve(new Response(JSON.stringify({ success: true }), { status: 200 }));
    }
    return Promise.resolve(new Response(null, { status: 200 }));
  };

  const deps: Dependencies = {
    anonClient: (authHeader: string) => {
      if (!authHeader.startsWith("Bearer user-jwt-token")) {
        return {
          auth: {
            getUser: () => Promise.resolve({ data: { user: null }, error: { message: "bad token" } }),
          },
        };
      }
      return {
        auth: {
          getUser: () => Promise.resolve({ data: { user: { id: userId } }, error: null }),
        },
      };
    },
    admin,
    serviceRoleKey: fakeServiceKey,
    supabaseUrl: "https://api.postora.cloud",
    fetch: defaultFetch as typeof fetch,
    now: () => Date.UTC(2026, 9, 2, 12, 0, 0),
    log: (event: LogEvent) => {
      logs.push(event);
    },
  };

  const run = (
    body: Record<string, unknown>,
    token = "user-jwt-token",
    method = "POST",
  ) =>
    handleRequest(
      new Request("https://api.postora.cloud/functions/v1/tiktok-review", {
        method,
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      }),
      deps,
      () => Promise.resolve(body),
    );

  return {
    deps,
    calls,
    logs,
    fetchCalls,
    run,
  };
}

Deno.test("missing bearer returns 401 UNAUTHORIZED", async () => {
  const f = createFixture();
  const res = await f.run({ action: "get", draftId: testDraftId }, "");
  assertEquals(res.status, 401);
  assertEquals(res.body.code, "UNAUTHORIZED");
  assertEquals(f.calls.length, 0);
});

Deno.test("service-role bearer returns 403 FORBIDDEN", async () => {
  const f = createFixture();
  const res = await f.run({ action: "get", draftId: testDraftId }, fakeServiceKey);
  assertEquals(res.status, 403);
  assertEquals(res.body.code, "FORBIDDEN");
  assertEquals(f.calls.length, 0);
});

Deno.test("invalid request body returns 400 and makes no database calls", async () => {
  const f = createFixture();
  const res = await f.run({ action: "not_a_real_action" });
  assertEquals(res.status, 400);
  assertEquals(res.body.code, "INVALID_REQUEST");
  assertEquals(f.calls.length, 0);
});

Deno.test("list and get database read errors return 500 INTERNAL and never empty data", async () => {
  const fList = createFixture({
    tableResults: {
      tiktok_review_drafts: { data: null, error: { message: "database statement timeout" } },
    },
  });
  const resList = await fList.run({
    action: "list",
    accountId: testAccountId,
    state: "pending_review",
  });
  assertEquals(resList.status, 500);
  assertEquals(resList.body.code, "INTERNAL");
  assertEquals(resList.body.data, undefined);

  const fGet = createFixture({
    tableResults: {
      tiktok_review_drafts: { data: null, error: { message: "database connection terminated" } },
    },
  });
  const resGet = await fGet.run({
    action: "get",
    draftId: testDraftId,
  });
  assertEquals(resGet.status, 500);
  assertEquals(resGet.body.code, "INTERNAL");
  assertEquals(resGet.body.data, undefined);
});

Deno.test("get of another user's draft returns 404 with query filtered by authenticated JWT user id", async () => {
  const f = createFixture({
    tableResults: {
      tiktok_review_drafts: { data: null, error: null },
    },
  });
  const res = await f.run({
    action: "get",
    draftId: testDraftId,
    user_id: "attacker-supplied-user-id", // untrusted body param
  });
  assertEquals(res.status, 404);
  assertEquals(res.body.code, "NOT_FOUND");

  const eqCalls = f.calls.filter((c) => c.name === "eq" && c.table === "tiktok_review_drafts");
  const userFilter = eqCalls.find((c) => c.args?.[0] === "user_id");
  assert(userFilter);
  // Must be filtered by JWT user, never the untrusted body user_id
  assertEquals(userFilter.args?.[1], testUserId);
});

Deno.test("save maps RPC error TIKTOK_REVIEW_REVISION_CONFLICT to 409 and 23503 to 422 MEDIA_NOT_OWNED", async () => {
  const fConflict = createFixture({
    rpcResults: {
      tiktok_review_save_draft: {
        data: null,
        error: { message: "TIKTOK_REVIEW_REVISION_CONFLICT: revision changed" },
      },
    },
  });
  const resConflict = await fConflict.run({
    action: "save",
    draftId: testDraftId,
    expectedRevision: 1,
    caption: "Caption edit",
    mediaFileId: testMediaId,
    mediaDurationSec: 30,
    settings: defaultSettings,
  });
  assertEquals(resConflict.status, 409);
  assertEquals(resConflict.body.code, "REVISION_CONFLICT");

  const fFk = createFixture({
    rpcResults: {
      tiktok_review_save_draft: {
        data: null,
        error: { code: "23503", message: "foreign key violation" },
      },
    },
  });
  const resFk = await fFk.run({
    action: "save",
    draftId: testDraftId,
    expectedRevision: 1,
    caption: "Caption edit",
    mediaFileId: testMediaId,
    mediaDurationSec: 30,
    settings: defaultSettings,
  });
  assertEquals(resFk.status, 422);
  assertEquals(resFk.body.code, "MEDIA_NOT_OWNED");
});

Deno.test("save maps POST_QUOTA_ database error to 429 QUOTA_EXCEEDED", async () => {
  const f = createFixture({
    rpcResults: {
      tiktok_review_save_draft: {
        data: null,
        error: { message: "POST_QUOTA_MONTHLY_LIMIT_EXCEEDED: posting quota reached" },
      },
    },
  });
  const res = await f.run({
    action: "save",
    draftId: testDraftId,
    expectedRevision: 1,
    caption: "Caption edit",
    mediaFileId: testMediaId,
    mediaDurationSec: 30,
    settings: defaultSettings,
  });
  assertEquals(res.status, 429);
  assertEquals(res.body.code, "QUOTA_EXCEEDED");
});

Deno.test("submit with a policy violation returns 422 POLICY_* and NEVER calls the submit RPC", async () => {
  const f = createFixture({
    fetchHandler: (url) => {
      if (url.includes("creator_info")) {
        return Promise.resolve(
          new Response(
            JSON.stringify({
              data: {
                ...defaultCreatorApiResponse.data,
                duet_disabled: true, // Creator disabled duet
              },
              error: { code: "ok" },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 422);
  assertEquals(res.body.code, "POLICY_DUET_NOT_ALLOWED");

  const submitRpc = f.calls.find((c) => c.name === "rpc:tiktok_review_submit");
  assertEquals(submitRpc, undefined);
});

Deno.test("submit with creator_info failure returns 502 PROVIDER_UNAVAILABLE and makes no submit RPC", async () => {
  const f = createFixture({
    fetchHandler: (url) => {
      if (url.includes("creator_info")) {
        return Promise.reject(new Error("TikTok API timeout"));
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 502);
  assertEquals(res.body.code, "PROVIDER_UNAVAILABLE");

  const submitRpc = f.calls.find((c) => c.name === "rpc:tiktok_review_submit");
  assertEquals(submitRpc, undefined);
});

Deno.test("submit mode now with created=true transitions pending_dispatch to dispatching, calls process-post once, and marks dispatched on 2xx", async () => {
  const f = createFixture();

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 200);
  assertEquals(res.body.data, {
    submissionId: testSubmissionId,
    postId: testPostId,
    state: "queued",
  });

  // Verify dispatch state transitions
  const dispatchStateRpcs = f.calls.filter((c) => c.name === "rpc:tiktok_review_set_dispatch_state");
  assertEquals(dispatchStateRpcs.length, 2);

  // Transition 1: pending_dispatch -> dispatching
  assertEquals(dispatchStateRpcs[0].args?.[0], {
    p_submission_id: testSubmissionId,
    p_from: ["pending_dispatch"],
    p_to: "dispatching",
  });

  // Transition 2: dispatching -> dispatched on 2xx
  assertEquals(dispatchStateRpcs[1].args?.[0], {
    p_submission_id: testSubmissionId,
    p_from: ["dispatching"],
    p_to: "dispatched",
  });

  // Exactly ONE process-post fetch with service key and correct body
  const processPostCalls = f.fetchCalls.filter((c) => c.url.includes("process-post"));
  assertEquals(processPostCalls.length, 1);
  const postCall = processPostCalls[0];
  const headers = postCall.init?.headers as Record<string, string>;
  assertEquals(headers["Authorization"], `Bearer ${fakeServiceKey}`);
  assertEquals(JSON.parse(postCall.init?.body as string), {
    post_id: testPostId,
    expected_scheduled_at: null,
  });
});

Deno.test("submit mode now with process-post 409 transitions dispatching to needs_attention", async () => {
  const f = createFixture({
    fetchHandler: (url) => {
      if (url.includes("process-post")) {
        return Promise.resolve(new Response(JSON.stringify({ error: "Conflict" }), { status: 409 }));
      }
      if (url.includes("creator_info")) {
        return Promise.resolve(
          new Response(JSON.stringify(defaultCreatorApiResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 200);

  const dispatchStateRpcs = f.calls.filter((c) => c.name === "rpc:tiktok_review_set_dispatch_state");
  assertEquals(dispatchStateRpcs.length, 2);
  assertEquals(dispatchStateRpcs[1].args?.[0], {
    p_submission_id: testSubmissionId,
    p_from: ["dispatching"],
    p_to: "needs_attention",
  });
});

Deno.test("submit mode now with process-post throwing network error transitions dispatching to unknown", async () => {
  const f = createFixture({
    fetchHandler: (url) => {
      if (url.includes("process-post")) {
        return Promise.reject(new Error("Network drop during dispatch"));
      }
      if (url.includes("creator_info")) {
        return Promise.resolve(
          new Response(JSON.stringify(defaultCreatorApiResponse), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        );
      }
      return Promise.resolve(new Response(null, { status: 200 }));
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 200);

  const dispatchStateRpcs = f.calls.filter((c) => c.name === "rpc:tiktok_review_set_dispatch_state");
  assertEquals(dispatchStateRpcs.length, 2);
  assertEquals(dispatchStateRpcs[1].args?.[0], {
    p_submission_id: testSubmissionId,
    p_from: ["dispatching"],
    p_to: "unknown",
  });
});

Deno.test("repeat submit returning created=false executes ZERO process-post fetches", async () => {
  const f = createFixture({
    rpcResults: {
      tiktok_review_submit: {
        data: {
          submission_id: testSubmissionId,
          post_id: testPostId,
          mode: "now",
          created: false, // Repeat submission
        },
        error: null,
      },
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "now",
    scheduledAt: null,
    timeZone: "UTC",
    consent: true,
  });

  assertEquals(res.status, 200);
  const processPostCalls = f.fetchCalls.filter((c) => c.url.includes("process-post"));
  assertEquals(processPostCalls.length, 0);

  const dispatchStateRpcs = f.calls.filter((c) => c.name === "rpc:tiktok_review_set_dispatch_state");
  assertEquals(dispatchStateRpcs.length, 0);
});

Deno.test("submit mode scheduled executes ZERO process-post fetches", async () => {
  const f = createFixture({
    rpcResults: {
      tiktok_review_submit: {
        data: {
          submission_id: testSubmissionId,
          post_id: testPostId,
          mode: "scheduled",
          created: true,
        },
        error: null,
      },
    },
  });

  const res = await f.run({
    action: "submit",
    draftId: testDraftId,
    expectedRevision: 1,
    requestId: testRequestId,
    mode: "scheduled",
    scheduledAt: "2026-10-05T09:00:00.000Z",
    timeZone: "America/New_York",
    consent: true,
  });

  assertEquals(res.status, 200);
  assertEquals(res.body.data, {
    submissionId: testSubmissionId,
    postId: testPostId,
    state: "scheduled",
  });

  const processPostCalls = f.fetchCalls.filter((c) => c.url.includes("process-post"));
  assertEquals(processPostCalls.length, 0);

  const dispatchStateRpcs = f.calls.filter((c) => c.name === "rpc:tiktok_review_set_dispatch_state");
  assertEquals(dispatchStateRpcs.length, 0);
});

Deno.test("creator_info request never includes the provider access token in logs", async () => {
  const f = createFixture();

  const res = await f.run({
    action: "creator_info",
    accountId: testAccountId,
  });

  assertEquals(res.status, 200);
  const loggedString = JSON.stringify(f.logs);
  assert(!loggedString.includes(fakeTiktokToken));
});
