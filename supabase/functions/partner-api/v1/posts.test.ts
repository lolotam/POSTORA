// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { handleRequest } from "../index.ts";
import { hashPartnerKey } from "../../_shared/partnerApiKeys.ts";
import { encodeId } from "./ids.ts";

// ---------------------------------------------------------------------------
// Phase 8 — posts surface (POST /v1/posts, GET /v1/posts/{id},
// GET /v1/posts/{id}/status, POST /v1/posts/{id}/schedule, DELETE /v1/posts/{id}/schedule).
//
// Load-bearing test: T1 & T3 (addressability / tenancy).
// Posts in Postora historically have only user_id and no workspace anchor.
// Addressability from /v1 is established EXCLUSIVELY via partner_api_posts
// binding rows in the key's workspace. A post in another workspace, or a
// UI-created post with no binding row, MUST answer resource_not_found (404).
//
// The stub APPLIES recorded .eq() and .in() filters to seeded rows so that
// tenancy assertions cannot pass vacuously.
// ---------------------------------------------------------------------------

const WS = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_WS = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_USER_ID = "22222222-2222-4222-8222-222222222222";

const ACCT_FB = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const ACCT_IG = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const ACCT_WA = "ffffffff-ffff-4fff-8fff-ffffffffffff";
const ACCT_INACTIVE = "12121212-1212-4212-8212-121212121212";
const ACCT_OTHER_USER = "34343434-3434-4434-8434-343434343434";
const ACCT_OTHER_WS = "56565656-5656-4565-8565-565656565656";

const POST_ID = "99999999-9999-4999-8999-999999999999";
const SCHEDULED_POST_ID = "99999999-9999-4999-8999-999999999998";
const COMPLETED_POST_ID = "99999999-9999-4999-8999-999999999997";
const OTHER_POST_ID = "88888888-8888-4888-8888-888888888888";
const UNBOUND_POST_ID = "77777777-7777-4777-8777-777777777777";

const MEDIA_ID = "66666666-6666-4666-8666-666666666666";
const FOREIGN_MEDIA_ID = "55555555-5555-4555-8555-555555555555";

const KEY_ID = "key-1";
const TEST_KEY = "pk_live_test";
const KEY_HASH = await hashPartnerKey(TEST_KEY);

const DEFAULT_KEY_ROW = {
  id: KEY_ID,
  workspace_id: WS,
  social_account_id: ACCT_FB,
  key_prefix: "pk_live_test",
  key_hash: KEY_HASH,
  scopes: ["posts:write", "posts:read", "posts:schedule"],
  rate_limit_per_min: 60,
  monthly_quota: null,
  expires_at: null,
  revoked_at: null,
};

const SOCIAL_ACCOUNTS = [
  {
    id: ACCT_FB,
    user_id: USER_ID,
    workspace_id: WS,
    platform: "facebook",
    platform_user_id: "fb-1",
    is_active: true,
  },
  {
    id: ACCT_IG,
    user_id: USER_ID,
    workspace_id: WS,
    platform: "instagram",
    platform_user_id: "ig-1",
    is_active: true,
  },
  {
    id: ACCT_WA,
    user_id: USER_ID,
    workspace_id: WS,
    platform: "whatsapp",
    platform_user_id: "wa-1",
    is_active: true,
  },
  {
    id: ACCT_INACTIVE,
    user_id: USER_ID,
    workspace_id: WS,
    platform: "facebook",
    platform_user_id: "fb-inact",
    is_active: false,
  },
  {
    id: ACCT_OTHER_USER,
    user_id: OTHER_USER_ID,
    workspace_id: WS,
    platform: "facebook",
    platform_user_id: "fb-other-user",
    is_active: true,
  },
  {
    id: ACCT_OTHER_WS,
    user_id: USER_ID,
    workspace_id: OTHER_WS,
    platform: "facebook",
    platform_user_id: "fb-other-ws",
    is_active: true,
  },
];

const BOUND_ACCOUNTS = [
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_FB },
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_IG },
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_WA },
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_INACTIVE },
  { key_id: KEY_ID, workspace_id: WS, social_account_id: ACCT_OTHER_USER },
];

const POST_ROWS = [
  {
    id: POST_ID,
    user_id: USER_ID,
    caption: "our test post",
    platforms: ["facebook"],
    media_file_ids: [MEDIA_ID],
    status: "pending",
    scheduled_at: null,
    posted_at: null,
    created_at: "2026-09-02T00:00:00Z",
    metadata: { selected_account_ids: [ACCT_FB] },
  },
  {
    id: SCHEDULED_POST_ID,
    user_id: USER_ID,
    caption: "our scheduled post",
    platforms: ["facebook"],
    media_file_ids: [],
    status: "scheduled",
    scheduled_at: "2026-09-03T12:00:00Z",
    posted_at: null,
    created_at: "2026-09-02T00:00:00Z",
    metadata: { selected_account_ids: [ACCT_FB] },
  },
  {
    id: COMPLETED_POST_ID,
    user_id: USER_ID,
    caption: "our completed post",
    platforms: ["facebook"],
    media_file_ids: [],
    status: "completed",
    scheduled_at: "2026-09-01T12:00:00Z",
    posted_at: "2026-09-01T12:05:00Z",
    created_at: "2026-09-01T00:00:00Z",
    metadata: { selected_account_ids: [ACCT_FB] },
  },
  {
    id: OTHER_POST_ID,
    user_id: OTHER_USER_ID,
    caption: "another workspace post",
    platforms: ["facebook"],
    media_file_ids: [],
    status: "pending",
    scheduled_at: null,
    posted_at: null,
    created_at: "2026-09-02T00:00:00Z",
    metadata: { selected_account_ids: [ACCT_OTHER_WS] },
  },
  {
    id: UNBOUND_POST_ID,
    user_id: USER_ID,
    caption: "ui-created post without binding row",
    platforms: ["facebook"],
    media_file_ids: [],
    status: "pending",
    scheduled_at: null,
    posted_at: null,
    created_at: "2026-09-02T00:00:00Z",
    metadata: { selected_account_ids: [ACCT_FB] },
  },
];

const PARTNER_API_POSTS = [
  { post_id: POST_ID, workspace_id: WS, key_id: KEY_ID },
  { post_id: SCHEDULED_POST_ID, workspace_id: WS, key_id: KEY_ID },
  { post_id: COMPLETED_POST_ID, workspace_id: WS, key_id: KEY_ID },
  { post_id: OTHER_POST_ID, workspace_id: OTHER_WS, key_id: "other-key" },
  // Note: UNBOUND_POST_ID has NO entry here deliberately.
];

const PENDING_MEDIA_ID = "44444444-4444-4444-8444-444444444444";
const REJECTED_MEDIA_ID = "33333333-3333-4333-8333-333333333333";

const MEDIA_ROWS = [
  { id: MEDIA_ID, workspace_id: WS, file_path: `${WS}/img.jpg` },
  { id: FOREIGN_MEDIA_ID, workspace_id: OTHER_WS, file_path: `${OTHER_WS}/img.jpg` },
  // Phase 9.3 scan states. MEDIA_ID above carries no scan_state at all, which
  // is the available-by-default control every media-bearing create relies on.
  { id: PENDING_MEDIA_ID, workspace_id: WS, file_path: `${WS}/pending.jpg`, scan_state: "pending" },
  { id: REJECTED_MEDIA_ID, workspace_id: WS, file_path: `${WS}/rejected.jpg`, scan_state: "rejected" },
];

const PLATFORM_POSTS = [
  {
    id: "pp-1",
    post_id: POST_ID,
    social_account_id: ACCT_FB,
    platform: "facebook",
    status: "pending",
    platform_post_id: null,
    platform_post_url: null,
    error_message: null,
    posted_at: null,
  },
  {
    id: "pp-2",
    post_id: SCHEDULED_POST_ID,
    social_account_id: ACCT_FB,
    platform: "facebook",
    status: "pending",
    platform_post_id: null,
    platform_post_url: null,
    error_message: null,
    posted_at: null,
  },
];

interface Filter {
  col: string;
  op: "eq" | "in";
  val: unknown;
}

interface StubOpts {
  keyRow?: unknown;
  posts?: Record<string, unknown>[];
  partnerApiPosts?: Record<string, unknown>[];
  socialAccounts?: Record<string, unknown>[];
  mediaFiles?: Record<string, unknown>[];
  platformPosts?: Record<string, unknown>[];
  createPostRpcError?: { message: string } | null;
}

function stub(opts: StubOpts = {}) {
  const rpcCalls: Array<{ name: string; args: any }> = [];
  const queries: Array<{ table: string; calls: Array<[string, ...unknown[]]>; filters: Filter[] }> = [];
  const updates: Array<{ table: string; values: any; filters: Filter[] }> = [];

  const seeded: Record<string, Record<string, unknown>[]> = {
    partner_api_keys: [(opts.keyRow ?? DEFAULT_KEY_ROW) as Record<string, unknown>],
    partner_api_key_accounts: [...BOUND_ACCOUNTS],
    social_accounts: opts.socialAccounts ?? [...SOCIAL_ACCOUNTS],
    posts: (opts.posts ?? POST_ROWS).map((p) => ({ ...p })),
    partner_api_posts: opts.partnerApiPosts ?? [...PARTNER_API_POSTS],
    media_files: opts.mediaFiles ?? [...MEDIA_ROWS],
    platform_posts: opts.platformPosts ?? [...PLATFORM_POSTS],
  };

  function builder(table: string) {
    const filters: Filter[] = [];
    const calls: Array<[string, ...unknown[]]> = [];
    let pendingUpdate: Record<string, unknown> | null = null;

    const matching = () => {
      return (seeded[table] ?? []).filter((row) =>
        filters.every((f) => {
          if (f.op === "eq") {
            if (f.val === null) return row[f.col] === null || row[f.col] === undefined;
            return row[f.col] === f.val;
          }
          if (f.op === "in") {
            const arr = Array.isArray(f.val) ? f.val : [];
            return arr.includes(row[f.col]);
          }
          return true;
        })
      );
    };

    const self: any = {
      select: (cols?: string) => {
        calls.push(["select", cols]);
        return self;
      },
      eq: (col: string, val: unknown) => {
        filters.push({ col, op: "eq", val });
        calls.push(["eq", col, val]);
        return self;
      },
      in: (col: string, val: unknown) => {
        filters.push({ col, op: "in", val });
        calls.push(["in", col, val]);
        return self;
      },
      order: (col: string, orderOpts?: unknown) => {
        calls.push(["order", col, orderOpts]);
        return self;
      },
      limit: (n: number) => {
        calls.push(["limit", n]);
        return self;
      },
      update: (values: Record<string, unknown>) => {
        pendingUpdate = values;
        calls.push(["update", values]);
        return self;
      },
      maybeSingle: () => {
        queries.push({ table, calls: [...calls], filters: [...filters] });
        if (pendingUpdate) {
          updates.push({ table, values: pendingUpdate, filters: [...filters] });
          const rows = matching();
          if (rows.length === 0) {
            return Promise.resolve({ data: null, error: null });
          }
          Object.assign(rows[0], pendingUpdate);
          return Promise.resolve({ data: { ...rows[0] }, error: null });
        }
        const rows = matching();
        return Promise.resolve({ data: rows[0] ? { ...rows[0] } : null, error: null });
      },
      then: (resolve: (v: unknown) => unknown) => {
        queries.push({ table, calls: [...calls], filters: [...filters] });
        const rows = matching().map((r) => ({ ...r }));
        return resolve({ data: rows, error: null });
      },
    };

    return self;
  }

  return {
    rpcCalls,
    queries,
    updates,
    seeded,
    rpc: (name: string, args?: any) => {
      rpcCalls.push({ name, args });
      if (name === "consume_partner_rate_v2") {
        return Promise.resolve({
          data: { allowed: true, remaining: 59, reset_seconds: 42 },
          error: null,
        });
      }
      if (name === "claim_partner_idempotency") {
        return Promise.resolve({
          data: { outcome: "claimed", attempt_token: "tok-1" },
          error: null,
        });
      }
      if (name === "complete_partner_idempotency") {
        return Promise.resolve({ data: null, error: null });
      }
      if (name === "partner_create_post") {
        if (opts.createPostRpcError) {
          return Promise.resolve({ data: null, error: opts.createPostRpcError });
        }
        const createdRow = {
          id: POST_ID,
          user_id: args.p_user_id,
          caption: args.p_caption,
          platforms: args.p_platforms,
          media_file_ids: args.p_media_file_ids,
          status: args.p_scheduled_at ? "scheduled" : "pending",
          scheduled_at: args.p_scheduled_at ?? null,
          posted_at: null,
          created_at: "2026-09-02T00:00:00Z",
          metadata: {
            selected_account_ids: args.p_selected_account_ids,
          },
        };
        return Promise.resolve({ data: createdRow, error: null });
      }
      return Promise.resolve({ data: null, error: null });
    },
    from: builder,
  } as any;
}

function v1(path: string, init: RequestInit = {}) {
  const customHeaders = init.headers ? (init.headers as Record<string, string>) : {};
  return new Request(`https://partner.example/functions/v1/partner-api${path}`, {
    ...init,
    headers: {
      "x-postora-key": TEST_KEY,
      ...customHeaders,
    },
  });
}

function createReq(payload: unknown, headers: Record<string, string> = {}) {
  return v1("/v1/posts", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "idempotency-key": "idem-post-1",
      ...headers,
    },
    body: JSON.stringify(payload),
  });
}

async function code(res: Response): Promise<string | null> {
  return (await res.json().catch(() => ({})))?.error?.code ?? null;
}

// ===========================================================================
// TENANCY / ADDRESSABILITY (the load-bearing group)
// ===========================================================================

Deno.test("T1: a post id belonging to ANOTHER workspace answers resource_not_found on all 4 post routes", async () => {
  const client = stub();

  const getRes = await handleRequest(v1(`/v1/posts/post_${OTHER_POST_ID}`), () => client);
  assertEquals(getRes.status, 404);
  assertEquals(await code(getRes), "resource_not_found");

  const statusRes = await handleRequest(v1(`/v1/posts/post_${OTHER_POST_ID}/status`), () => client);
  assertEquals(statusRes.status, 404);
  assertEquals(await code(statusRes), "resource_not_found");

  const schedRes = await handleRequest(
    v1(`/v1/posts/post_${OTHER_POST_ID}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: "2026-09-03T14:00:00Z" }),
    }),
    () => client,
  );
  assertEquals(schedRes.status, 404);
  assertEquals(await code(schedRes), "resource_not_found");

  const unschedRes = await handleRequest(
    v1(`/v1/posts/post_${OTHER_POST_ID}/schedule`, { method: "DELETE" }),
    () => client,
  );
  assertEquals(unschedRes.status, 404);
  assertEquals(await code(unschedRes), "resource_not_found");
});

Deno.test("T2: the control for T1 -- the key's OWN post resolves 200 on all four", async () => {
  const client = stub();

  const getRes = await handleRequest(v1(`/v1/posts/post_${POST_ID}`), () => client);
  assertEquals(getRes.status, 200);
  const getBody = await getRes.json();
  assertEquals(getBody.id, `post_${POST_ID}`);

  const statusRes = await handleRequest(v1(`/v1/posts/post_${POST_ID}/status`), () => client);
  assertEquals(statusRes.status, 200);
  const statusBody = await statusRes.json();
  assertEquals(statusBody.post_id, `post_${POST_ID}`);

  const schedRes = await handleRequest(
    v1(`/v1/posts/post_${POST_ID}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: "2026-09-03T14:00:00Z" }),
    }),
    () => client,
  );
  assertEquals(schedRes.status, 200);
  const schedBody = await schedRes.json();
  assertEquals(schedBody.id, `post_${POST_ID}`);
  assertEquals(schedBody.status, "scheduled");

  const unschedRes = await handleRequest(
    v1(`/v1/posts/post_${SCHEDULED_POST_ID}/schedule`, { method: "DELETE" }),
    () => client,
  );
  assertEquals(unschedRes.status, 200);
  const unschedBody = await unschedRes.json();
  assertEquals(unschedBody.id, `post_${SCHEDULED_POST_ID}`);
  assertEquals(unschedBody.status, "pending");
});

Deno.test("T3: a post with NO partner_api_posts binding row answers resource_not_found even though the posts row exists and belongs to the same user", async () => {
  const client = stub();

  const res = await handleRequest(v1(`/v1/posts/post_${UNBOUND_POST_ID}`), () => client);
  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");

  const statusRes = await handleRequest(v1(`/v1/posts/post_${UNBOUND_POST_ID}/status`), () => client);
  assertEquals(statusRes.status, 404);
  assertEquals(await code(statusRes), "resource_not_found");
});

Deno.test("T4: a malformed post id answers resource_not_found and never reaches the post database tables", async () => {
  const client = stub();

  const notUuid = await handleRequest(v1("/v1/posts/post_notauuid"), () => client);
  assertEquals(notUuid.status, 404);
  assertEquals(await code(notUuid), "resource_not_found");

  const wrongPrefix = await handleRequest(v1(`/v1/posts/msg_${POST_ID}`), () => client);
  assertEquals(wrongPrefix.status, 404);
  assertEquals(await code(wrongPrefix), "resource_not_found");

  const postTableQueries = client.queries.filter(
    (q: any) => q.table === "posts" || q.table === "partner_api_posts",
  );
  assertEquals(postTableQueries.length, 0, "malformed ids must not query database tables");
});

// ===========================================================================
// CREATE VALIDATION (C1..C11)
// ===========================================================================

Deno.test("C1: missing Idempotency-Key header on POST /v1/posts answers missing_idempotency_key (400)", async () => {
  const client = stub();
  const res = await handleRequest(
    v1("/v1/posts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targets: [`acc_${ACCT_FB}`], caption: "hi" }),
    }),
    () => client,
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "missing_idempotency_key");
});

Deno.test("C2: empty targets array or missing targets answers invalid_request (400)", async () => {
  const client = stub();

  const emptyTargets = await handleRequest(createReq({ targets: [], caption: "hi" }), () => client);
  assertEquals(emptyTargets.status, 400);
  assertEquals(await code(emptyTargets), "invalid_request");

  const missingTargets = await handleRequest(createReq({ caption: "hi" }), () => client);
  assertEquals(missingTargets.status, 400);
  assertEquals(await code(missingTargets), "invalid_request");
});

Deno.test("C3: a target account NOT bound to this key answers resource_not_found (404), never resource_forbidden", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({ targets: [`acc_${ACCT_OTHER_WS}`], caption: "hi" }),
    () => client,
  );
  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
});

Deno.test("C4: targets owned by two different user_ids answers invalid_request (400) explaining single owner rule", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({ targets: [`acc_${ACCT_FB}`, `acc_${ACCT_OTHER_USER}`], caption: "hi" }),
    () => client,
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body?.error?.code, "invalid_request");
  assertEquals(
    body.error.message.includes("All target accounts must belong to one Postora user"),
    true,
  );
});

Deno.test("C5: a whatsapp target answers unsupported_capability (422)", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({ targets: [`acc_${ACCT_WA}`], caption: "hi" }),
    () => client,
  );
  assertEquals(res.status, 422);
  const body = await res.json();
  assertEquals(body?.error?.code, "unsupported_capability");
  assertEquals(body.error.message.includes("WhatsApp accounts cannot receive feed posts"), true);
});

Deno.test("C6: an inactive target account answers invalid_request (400)", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({ targets: [`acc_${ACCT_INACTIVE}`], caption: "hi" }),
    () => client,
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body?.error?.code, "invalid_request");
  assertEquals(body.error.message.includes("disconnected"), true);
});

Deno.test("C7: a media_file_ids entry from another workspace answers resource_not_found (404)", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({
      targets: [`acc_${ACCT_FB}`],
      caption: "hi",
      media_file_ids: [`media_${FOREIGN_MEDIA_ID}`],
    }),
    () => client,
  );
  assertEquals(res.status, 404);
  assertEquals(await code(res), "resource_not_found");
});

// Phase 9.3: the ONE sendability rule (partnerMediaStore.mediaSendability)
// applies at this door too. A post is a customer-reaching send of the file.
for (
  const [label, id, expectedCode, expectedStatus] of [
    ["pending", PENDING_MEDIA_ID, "media_pending", 409],
    ["rejected", REJECTED_MEDIA_ID, "media_rejected", 422],
  ] as const
) {
  Deno.test(`C13: a media_file_ids entry in scan_state ${label} answers ${expectedCode} and creates nothing`, async () => {
    const client = stub();
    const res = await handleRequest(
      createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi", media_file_ids: [`media_${id}`] }),
      () => client,
    );
    assertEquals(res.status, expectedStatus);
    assertEquals(await code(res), expectedCode);
    assertEquals(client.rpcCalls.filter((c: any) => c.name === "partner_create_post").length, 0);
  });
}

Deno.test("C8: scheduled_at: 'May 8, 2026' answers invalid_request (400) because strict ISO is required", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({
      targets: [`acc_${ACCT_FB}`],
      caption: "hi",
      scheduled_at: "May 8, 2026",
    }),
    () => client,
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
});

Deno.test("C9: scheduled_at: '2026-09-03T14:00:00' (no offset) answers invalid_request (400)", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({
      targets: [`acc_${ACCT_FB}`],
      caption: "hi",
      scheduled_at: "2026-09-03T14:00:00",
    }),
    () => client,
  );
  assertEquals(res.status, 400);
  assertEquals(await code(res), "invalid_request");
});

// Codex review on PR #125: Date.parse and Date.UTC both NORMALISE, so a
// well-shaped but impossible timestamp used to publish on a day the partner
// never named. Every value here matches the ISO shape regex; only the
// calendar round-trip can refuse it.
for (
  const [label, value] of [
    ["Feb 30th", "2026-02-30T14:00:00Z"],
    ["hour 24", "2026-09-03T24:00:00Z"],
    ["minute 60", "2026-09-03T14:60:00Z"],
    ["month 13", "2026-13-01T14:00:00Z"],
    ["offset +25:00", "2026-09-03T14:00:00+25:00"],
  ] as const
) {
  Deno.test(`C12: a shape-valid but impossible scheduled_at (${label}) answers invalid_request`, async () => {
    const client = stub();
    const res = await handleRequest(
      createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi", scheduled_at: value }),
      () => client,
    );
    assertEquals(res.status, 400);
    assertEquals(await code(res), "invalid_request");
    assertEquals(client.rpcCalls.filter((c: any) => c.name === "partner_create_post").length, 0);
  });
}

Deno.test("C12 control: a leap-day timestamp with an offset is accepted and normalised to UTC", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi", scheduled_at: "2028-02-29T02:30:00+03:00" }),
    () => client,
  );
  assertEquals(res.status, 201);
  const call = client.rpcCalls.find((c: any) => c.name === "partner_create_post");
  assertEquals(call.args.p_scheduled_at, "2028-02-28T23:30:00.000Z");
});

Deno.test("C10: a valid create calls partner_create_post RPC exactly once with derived platforms, user_id, and account UUIDs", async () => {
  const client = stub();
  const res = await handleRequest(
    createReq({
      targets: [`acc_${ACCT_FB}`, `acc_${ACCT_IG}`],
      caption: "cross-platform announcement",
      media_file_ids: [`media_${MEDIA_ID}`],
      scheduled_at: "2026-09-03T14:00:00Z",
    }),
    () => client,
  );
  assertEquals(res.status, 201);
  const body = await res.json();
  assertEquals(body.id, `post_${POST_ID}`);
  assertEquals(body.targets, [`acc_${ACCT_FB}`, `acc_${ACCT_IG}`]);
  assertEquals(body.media_file_ids, [`media_${MEDIA_ID}`]);

  const rpcCalls = client.rpcCalls.filter((c: any) => c.name === "partner_create_post");
  assertEquals(rpcCalls.length, 1, "partner_create_post RPC must be called exactly once");

  const args = rpcCalls[0].args;
  assertEquals(args.p_workspace_id, WS);
  assertEquals(args.p_key_id, KEY_ID);
  assertEquals(args.p_user_id, USER_ID);
  assertEquals(args.p_caption, "cross-platform announcement");
  assertEquals(args.p_platforms, ["facebook", "instagram"]);
  assertEquals(args.p_media_file_ids, [MEDIA_ID]);
  assertEquals(args.p_selected_account_ids, [ACCT_FB, ACCT_IG]);
  assertEquals(args.p_scheduled_at, "2026-09-03T14:00:00.000Z");
});

Deno.test("C11: POST_QUOTA_ RPC error answers quota_exceeded (429), while ordinary RPC error answers internal_error (500)", async () => {
  const quotaClient = stub({
    createPostRpcError: { message: "POST_QUOTA_DAILY_EXCEEDED: Daily limit reached" },
  });
  const quotaRes = await handleRequest(
    createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi" }),
    () => quotaClient,
  );
  assertEquals(quotaRes.status, 429);
  assertEquals(await code(quotaRes), "quota_exceeded");

  const otherClient = stub({
    createPostRpcError: { message: "database statement timeout" },
  });
  const otherRes = await handleRequest(
    createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi" }),
    () => otherClient,
  );
  assertEquals(otherRes.status, 500);
  assertEquals(await code(otherRes), "internal_error");
});

// ===========================================================================
// SCHEDULE / UNSCHEDULE (S1..S4)
// ===========================================================================

Deno.test("S1: POST /schedule on a completed post answers invalid_request (400)", async () => {
  const client = stub();
  const res = await handleRequest(
    v1(`/v1/posts/post_${COMPLETED_POST_ID}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: "2026-09-03T14:00:00Z" }),
    }),
    () => client,
  );
  assertEquals(res.status, 400);
  const body = await res.json();
  assertEquals(body?.error?.code, "invalid_request");
  assertEquals(body.error.message.includes('status "completed" cannot be scheduled'), true);
});

Deno.test("S2: POST /schedule writes status: 'scheduled' with scheduled_at, and filters .in('status', ['pending', 'scheduled'])", async () => {
  const client = stub();
  const res = await handleRequest(
    v1(`/v1/posts/post_${POST_ID}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: "2026-09-03T14:00:00Z" }),
    }),
    () => client,
  );
  assertEquals(res.status, 200);

  const postUpdates = client.updates.filter((u: any) => u.table === "posts");
  assertEquals(postUpdates.length, 1, "exactly one update on posts must be issued");

  const update = postUpdates[0];
  assertEquals(update.values.status, "scheduled");
  assertEquals(update.values.scheduled_at, "2026-09-03T14:00:00.000Z");

  const statusFilter = update.filters.find((f: any) => f.col === "status");
  assert(statusFilter, "update MUST filter on status column");
  assertEquals(statusFilter.op, "in");
  assertEquals(statusFilter.val, ["pending", "scheduled"]);
});

Deno.test("S3: DELETE /schedule on a scheduled post writes scheduled_at: null and status: 'pending'", async () => {
  const client = stub();
  const res = await handleRequest(
    v1(`/v1/posts/post_${SCHEDULED_POST_ID}/schedule`, { method: "DELETE" }),
    () => client,
  );
  assertEquals(res.status, 200);

  const postUpdates = client.updates.filter((u: any) => u.table === "posts");
  assertEquals(postUpdates.length, 1);

  const update = postUpdates[0];
  assertEquals(update.values.scheduled_at, null);
  assertEquals(update.values.status, "pending");

  const statusFilter = update.filters.find((f: any) => f.col === "status");
  assert(statusFilter, "delete-schedule must be guarded by status = 'scheduled'");
  assertEquals(statusFilter.op, "eq");
  assertEquals(statusFilter.val, "scheduled");
});

Deno.test("S4: DELETE /schedule on an already-pending post is an idempotent 200 without issuing a database update", async () => {
  const client = stub();
  const res = await handleRequest(
    v1(`/v1/posts/post_${POST_ID}/schedule`, { method: "DELETE" }),
    () => client,
  );
  assertEquals(res.status, 200);
  const body = await res.json();
  assertEquals(body.status, "pending");

  const postUpdates = client.updates.filter((u: any) => u.table === "posts");
  assertEquals(postUpdates.length, 0, "an already-pending post needs no database update");
});

// ===========================================================================
// SCOPES AND ROUTING (R1..R3)
// ===========================================================================

Deno.test("R1: a key holding only posts:read gets insufficient_scope (403) on POST /v1/posts and POST /schedule, but 200 on GET", async () => {
  const readOnlyKey = { ...DEFAULT_KEY_ROW, scopes: ["posts:read"] };

  const createRes = await handleRequest(
    createReq({ targets: [`acc_${ACCT_FB}`], caption: "hi" }),
    () => stub({ keyRow: readOnlyKey }),
  );
  assertEquals(createRes.status, 403);
  assertEquals(await code(createRes), "insufficient_scope");

  const schedRes = await handleRequest(
    v1(`/v1/posts/post_${POST_ID}/schedule`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scheduled_at: "2026-09-03T14:00:00Z" }),
    }),
    () => stub({ keyRow: readOnlyKey }),
  );
  assertEquals(schedRes.status, 403);
  assertEquals(await code(schedRes), "insufficient_scope");

  const getRes = await handleRequest(
    v1(`/v1/posts/post_${POST_ID}`),
    () => stub({ keyRow: readOnlyKey }),
  );
  assertEquals(getRes.status, 200);
});

Deno.test("R2: GET /v1/posts/{id}/status resolves to status route, not to /v1/posts/{id}", async () => {
  const client = stub();
  const res = await handleRequest(v1(`/v1/posts/post_${POST_ID}/status`), () => client);
  assertEquals(res.status, 200);

  const body = await res.json();
  assert("post_id" in body, "status response has post_id field");
  assert("targets" in body, "status response has targets array");
  assertEquals(Array.isArray(body.targets), true);
  assertEquals(body.targets[0].platform, "facebook");
});

Deno.test("R3: DELETE /v1/posts answers 405 with Allow header", async () => {
  const client = stub();
  const res = await handleRequest(v1("/v1/posts", { method: "DELETE" }), () => client);
  assertEquals(res.status, 405);
  assertEquals(await code(res), "method_not_allowed");

  const allow = res.headers.get("allow");
  assert(allow !== null, "405 response must include Allow header");
  assertEquals(allow.includes("POST"), true);
});
