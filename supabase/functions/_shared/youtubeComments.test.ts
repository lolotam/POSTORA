import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  deleteOwnComment,
  listChannelVideos,
  listThreads,
  replyToThread,
  setModerationStatus,
  uploadsPlaylistId,
  videoTitles,
} from "./youtubeComments.ts";

type Call = { url: string; init?: RequestInit };

function fakeFetch(
  handler: (
    url: string,
    init?: RequestInit,
  ) => { status: number; body: unknown },
) {
  const calls: Call[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

function fakeAdmin(options: {
  account?: {
    id?: string;
    access_token?: string | null;
    refresh_token?: string | null;
    token_expires_at?: string | null;
    needs_reauth?: boolean;
  };
  acquireResult?: Record<string, unknown>;
  /** Pops before acquireResult: lets a test hand out the lease on a later call. */
  acquireResults?: Record<string, unknown>[];
} = {}) {
  const updates: Array<Record<string, unknown>> = [];
  const rpcCalls: Array<{ fn: string; params: Record<string, unknown> }> = [];
  const row = {
    id: options.account?.id ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    access_token: options.account?.access_token ?? "tok",
    refresh_token: options.account?.refresh_token === undefined
      ? "rt"
      : options.account.refresh_token,
    token_expires_at: options.account?.token_expires_at ?? new Date(0).toISOString(),
    needs_reauth: options.account?.needs_reauth ?? false,
    is_active: true,
    auth_provider: "native",
    account_metadata: {
      granted_scopes: [
        "https://www.googleapis.com/auth/youtube.force-ssl",
      ],
    },
  };
  return {
    updates,
    rpcCalls,
    row,
    rpc: (fn: string, params: Record<string, unknown>) => {
      rpcCalls.push({ fn, params });
      if (fn === "acquire_youtube_refresh_lease") {
        const next = options.acquireResults?.shift();
        return Promise.resolve({
          data: next ?? options.acquireResult ?? {
            ok: true,
            lease_token: "55555555-5555-4555-8555-555555555555",
            expires_at: new Date(Date.now() + 60_000).toISOString(),
          },
          error: null,
        });
      }
      if (fn === "release_youtube_refresh_lease") {
        return Promise.resolve({ data: true, error: null });
      }
      if (fn === "store_youtube_refreshed_token_with_lease") {
        row.access_token = String(params.p_new_access_token);
        row.token_expires_at = String(params.p_new_token_expires_at);
        row.needs_reauth = false;
        updates.push({
          access_token: params.p_new_access_token,
          token_expires_at: params.p_new_token_expires_at,
          needs_reauth: false,
        });
        return Promise.resolve({ data: { ok: true }, error: null });
      }
      if (fn === "record_youtube_refresh_failure_with_lease") {
        const isInvalidGrant = params.p_is_invalid_grant === true;
        if (isInvalidGrant) row.needs_reauth = true;
        updates.push({
          needs_reauth: isInvalidGrant,
          last_refresh_error: params.p_error_message,
        });
        return Promise.resolve({
          data: {
            ok: true,
            needs_reauth: isInvalidGrant,
            failure_count: 1,
            transitioned: isInvalidGrant,
            enqueued: 0,
          },
          error: null,
        });
      }
      return Promise.resolve({ data: null, error: { message: `unexpected rpc ${fn}` } });
    },
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: { ...row }, error: null }),
        }),
      }),
      update: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return { eq: () => Promise.resolve({ error: null }) };
      },
    }),
  };
}

const IN_AN_HOUR = new Date(Date.now() + 3_600_000).toISOString();
const native = {
  id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  user_id: "u",
  platform: "youtube",
  auth_provider: "native",
  access_token: "tok",
  refresh_token: "rt",
  token_expires_at: IN_AN_HOUR,
  platform_user_id: "UC-me",
};

const thread = {
  id: "t1",
  snippet: {
    videoId: "v1",
    totalReplyCount: 1,
    topLevelComment: {
      id: "t1",
      snippet: {
        videoId: "v1",
        textOriginal: "hello",
        authorDisplayName: "Ann",
        authorProfileImageUrl: "https://img/a.png",
        authorChannelId: { value: "UC-ann" },
        publishedAt: "2026-09-01T00:00:00Z",
        likeCount: 2,
      },
    },
  },
  replies: {
    comments: [{
      id: "r1",
      snippet: {
        videoId: "v1",
        parentId: "t1",
        textOriginal: "hi",
        authorDisplayName: "Me",
        authorChannelId: { value: "UC-me" },
        publishedAt: "2026-09-01T01:00:00Z",
        likeCount: 0,
      },
    }],
  },
};

Deno.test("native listThreads asks for the whole channel, newest first, and flattens replies", async () => {
  const { calls, fetcher } = fakeFetch(() => ({
    status: 200,
    body: { items: [thread], nextPageToken: "p2" },
  }));
  const result = await listThreads(native, { admin: fakeAdmin(), fetcher }, {
    channelId: "UC-me",
  });
  if (!result.ok) throw new Error(result.message);
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/commentThreads");
  assertEquals(url.searchParams.get("allThreadsRelatedToChannelId"), "UC-me");
  assertEquals(url.searchParams.get("order"), "time");
  assertEquals(url.searchParams.get("part"), "snippet,replies");
  assertEquals(
    (calls[0].init?.headers as Record<string, string>).Authorization,
    "Bearer tok",
  );
  assertEquals(result.value.nextPageToken, "p2");
  assertEquals(result.value.items[0].authorChannelId, "UC-ann");
  assertEquals(result.value.items[0].replies[0].parentId, "t1");
});

// comments.list?id= answers the reply target's snippet; comments.insert answers with the new id.
function replyFetch(target: { id: string; parentId?: string }) {
  return fakeFetch((_url, init) =>
    init?.method === "POST" ? { status: 200, body: { id: "new" } } : {
      status: 200,
      body: {
        items: [{
          id: target.id,
          snippet: target.parentId ? { parentId: target.parentId } : {},
        }],
      },
    }
  );
}

Deno.test("replyToThread posts comments.insert against a top-level comment's own id", async () => {
  const { calls, fetcher } = replyFetch({ id: "t1" });
  const result = await replyToThread(
    native,
    { admin: fakeAdmin(), fetcher },
    "t1",
    "thanks",
  );
  assertEquals(result, { ok: true, value: { id: "new" } });
  assertEquals(new URL(calls[0].url).searchParams.get("id"), "t1");
  assertEquals(JSON.parse(String(calls[1].init?.body)), {
    snippet: { parentId: "t1", textOriginal: "thanks" },
  });
});

Deno.test("a reply to a reply is posted against the thread's top-level comment", async () => {
  const { calls, fetcher } = replyFetch({ id: "r1", parentId: "t1" });
  const result = await replyToThread(
    native,
    { admin: fakeAdmin(), fetcher },
    "r1",
    "thanks",
  );
  assertEquals(result, { ok: true, value: { id: "new" } });
  assertEquals(calls.length, 2);
  assertEquals(JSON.parse(String(calls[1].init?.body)), {
    snippet: { parentId: "t1", textOriginal: "thanks" },
  });
});

Deno.test("a reply target that no longer exists is not_found and nothing is posted", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
  const result = await replyToThread(
    native,
    { admin: fakeAdmin(), fetcher },
    "gone",
    "thanks",
  );
  if (result.ok) throw new Error("expected failure");
  assertEquals(result.kind, "not_found");
  assertEquals(calls.length, 1);
});

Deno.test("hide is setModerationStatus=rejected, unhide is published", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 204, body: null }));
  await setModerationStatus(
    native,
    { admin: fakeAdmin(), fetcher },
    "t1",
    "rejected",
  );
  await setModerationStatus(
    native,
    { admin: fakeAdmin(), fetcher },
    "t1",
    "published",
  );
  assertEquals(
    new URL(calls[0].url).searchParams.get("moderationStatus"),
    "rejected",
  );
  assertEquals(
    new URL(calls[1].url).searchParams.get("moderationStatus"),
    "published",
  );
});

Deno.test("deleteOwnComment refuses somebody else's comment before calling delete", async () => {
  const { calls, fetcher } = fakeFetch((url) =>
    url.includes("/comments?")
      ? {
        status: 200,
        body: {
          items: [{
            id: "c9",
            snippet: { authorChannelId: { value: "UC-ann" } },
          }],
        },
      }
      : { status: 204, body: null }
  );
  const result = await deleteOwnComment(
    native,
    { admin: fakeAdmin(), fetcher },
    "c9",
  );
  assertEquals(result.ok, false);
  assertEquals(calls.length, 1);
});

Deno.test("a 403 insufficientPermissions drops the scope and reports scope_missing", async () => {
  const admin = fakeAdmin();
  const { fetcher } = fakeFetch(() => ({
    status: 403,
    body: { error: { errors: [{ reason: "insufficientPermissions" }] } },
  }));
  const result = await listThreads(native, { admin, fetcher }, {
    channelId: "UC-me",
  });
  assertEquals(result.ok, false);
  if (!result.ok) assertEquals(result.kind, "scope_missing");
  assertEquals(
    (admin.updates[0].account_metadata as { granted_scopes: string[] })
      .granted_scopes,
    [],
  );
  assertEquals(admin.updates.some((update) => "needs_reauth" in update), false);
});

Deno.test("a quota 403 reports quota and writes nothing", async () => {
  const admin = fakeAdmin();
  const { fetcher } = fakeFetch(() => ({
    status: 403,
    body: { error: { errors: [{ reason: "quotaExceeded" }] } },
  }));
  const result = await listThreads(native, { admin, fetcher }, {
    channelId: "UC-me",
  });
  if (result.ok) throw new Error("expected failure");
  assertEquals(result.kind, "quota");
  assertEquals(admin.updates, []);
});

const EXPIRED = { ...native, token_expires_at: new Date(0).toISOString() };

function stubGlobalFetch(status: number, body: unknown): () => void {
  const original = globalThis.fetch;
  const oldId = Deno.env.get("GOOGLE_CLIENT_ID");
  const oldSecret = Deno.env.get("GOOGLE_CLIENT_SECRET");
  Deno.env.set("GOOGLE_CLIENT_ID", ["yt", "client", "id"].join("-"));
  Deno.env.set("GOOGLE_CLIENT_SECRET", ["yt", "client", "secret"].join("-"));
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
      }),
    )) as typeof fetch;
  return () => {
    globalThis.fetch = original;
    if (oldId === undefined) Deno.env.delete("GOOGLE_CLIENT_ID");
    else Deno.env.set("GOOGLE_CLIENT_ID", oldId);
    if (oldSecret === undefined) Deno.env.delete("GOOGLE_CLIENT_SECRET");
    else Deno.env.set("GOOGLE_CLIENT_SECRET", oldSecret);
  };
}

function touchedReauth(admin: ReturnType<typeof fakeAdmin>): boolean {
  return admin.updates.some((update) => "needs_reauth" in update);
}

Deno.test("a transient refresh failure is upstream and leaves token health alone", async () => {
  const restore = stubGlobalFetch(503, { error: "temporarily_unavailable" });
  try {
    const admin = fakeAdmin();
    const result = await listThreads(EXPIRED, { admin }, { channelId: "UC-me" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.kind, "upstream");
    assertEquals(touchedReauth(admin), false);
  } finally {
    restore();
  }
});

Deno.test("an invalid_grant refresh marks the row for reconnect via lease RPC and never loops", async () => {
  const restore = stubGlobalFetch(400, { error: "invalid_grant" });
  try {
    const admin = fakeAdmin();
    const result = await listThreads(EXPIRED, { admin }, { channelId: "UC-me" });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.kind, "unauthorized");
    assertEquals(
      admin.rpcCalls.some((c) => c.fn === "acquire_youtube_refresh_lease"),
      true,
    );
    assertEquals(
      admin.rpcCalls.some((c) =>
        c.fn === "record_youtube_refresh_failure_with_lease" &&
        c.params.p_is_invalid_grant === true
      ),
      true,
    );
    assertEquals(admin.updates[0].needs_reauth, true);
    assertEquals(
      admin.updates[0].last_refresh_error,
      "YouTube refresh failed: invalid_grant",
    );
  } finally {
    restore();
  }
});

Deno.test("when another worker holds the lease and wrote a fresh token, comments reuse it without calling Google OAuth", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("Google OAuth must not be called when lease is held");
  }) as typeof fetch;
  try {
    const winnerToken = ["winner", "fresh", "tok"].join("-");
    const admin = fakeAdmin({
      acquireResult: { ok: false, reason: "lease_held" },
      account: {
        access_token: winnerToken,
        token_expires_at: IN_AN_HOUR,
        needs_reauth: false,
      },
    });
    const { calls, fetcher } = fakeFetch(() => ({
      status: 200,
      body: { items: [thread] },
    }));
    const result = await listThreads({ ...EXPIRED }, { admin, fetcher }, {
      channelId: "UC-me",
    });
    if (!result.ok) throw new Error(result.message);
    assertEquals(calls.length, 1);
    assertEquals(
      (calls[0].init?.headers as Record<string, string>).Authorization,
      `Bearer ${winnerToken}`,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a 401 on a reused winner token still forces one refresh", async () => {
  // Another worker holds the lease and has just stored a fresh winner token.
  // The comment call reuses it, and the provider 401s it anyway (revoked
  // early): because this call did not mint the token, one forced refresh must
  // still happen before the call is given up on.
  const restore = stubGlobalFetch(200, {
    access_token: ["forced", "fresh"].join("-"),
    expires_in: 3600,
  });
  try {
    const winnerToken = ["winner", "fresh", "tok"].join("-");
    const admin = fakeAdmin({
      acquireResults: [{ ok: false, reason: "lease_held" }],
      account: {
        access_token: winnerToken,
        token_expires_at: IN_AN_HOUR,
        needs_reauth: false,
      },
    });
    let attempts = 0;
    const { calls, fetcher } = fakeFetch(() => {
      attempts += 1;
      return attempts === 1
        ? { status: 401, body: { error: { message: "Invalid Credentials" } } }
        : { status: 200, body: { items: [thread] } };
    });
    const result = await listThreads({ ...EXPIRED }, { admin, fetcher }, {
      channelId: "UC-me",
    });
    if (!result.ok) throw new Error(result.message);
    assertEquals(calls.length, 2);
    assertEquals(
      (calls[1].init?.headers as Record<string, string>).Authorization,
      `Bearer ${["forced", "fresh"].join("-")}`,
    );
    // The forced refresh is persisted through the store RPC.
    assertEquals(admin.updates[0].access_token, ["forced", "fresh"].join("-"));
  } finally {
    restore();
  }
});

Deno.test("when another worker holds the lease and no fresh token exists, comments return retryable upstream refusal", async () => {
  const original = globalThis.fetch;
  let googleCalled = false;
  globalThis.fetch = (() => {
    googleCalled = true;
    throw new Error("Google OAuth must not be called when lease is held");
  }) as typeof fetch;
  try {
    const admin = fakeAdmin({
      acquireResult: { ok: false, reason: "lease_held" },
      account: {
        access_token: "stale-tok",
        token_expires_at: new Date(0).toISOString(),
        needs_reauth: false,
      },
    });
    const result = await listThreads({ ...EXPIRED }, { admin }, {
      channelId: "UC-me",
    });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.kind, "upstream");
    assertEquals(googleCalled, false);
    assertEquals(touchedReauth(admin), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a missing refresh token is unauthorized without calling Google", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (() => {
    throw new Error("the oauth2 endpoint must not be called");
  }) as typeof fetch;
  try {
    const admin = fakeAdmin();
    const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: {} }));
    const result = await listThreads(
      { ...EXPIRED, refresh_token: null },
      { admin, fetcher },
      { channelId: "UC-me" },
    );
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.kind, "unauthorized");
    assertEquals(calls.length, 0);
    assertEquals(touchedReauth(admin), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a 401 refreshes the token once and retries the same call", async () => {
  const restore = stubGlobalFetch(200, {
    access_token: "fresh",
    expires_in: 3600,
  });
  try {
    const admin = fakeAdmin();
    let attempts = 0;
    const { calls, fetcher } = fakeFetch(() => {
      attempts += 1;
      return attempts === 1
        ? { status: 401, body: { error: { message: "Invalid Credentials" } } }
        : { status: 200, body: { items: [thread] } };
    });
    const result = await listThreads(native, { admin, fetcher }, {
      channelId: "UC-me",
    });
    if (!result.ok) throw new Error(result.message);
    assertEquals(result.value.items[0].id, "t1");
    assertEquals(calls.length, 2);
    assertEquals(
      (calls[1].init?.headers as Record<string, string>).Authorization,
      "Bearer fresh",
    );
    assertEquals(admin.updates[0].access_token, "fresh");
  } finally {
    restore();
  }
});

Deno.test("a second 401 after the refresh is reported as unauthorized", async () => {
  const restore = stubGlobalFetch(200, {
    access_token: "fresh",
    expires_in: 3600,
  });
  try {
    const { calls, fetcher } = fakeFetch(() => ({
      status: 401,
      body: { error: { message: "Invalid Credentials" } },
    }));
    const result = await listThreads(native, { admin: fakeAdmin(), fetcher }, {
      channelId: "UC-me",
    });
    if (result.ok) throw new Error("expected failure");
    assertEquals(result.kind, "unauthorized");
    assertEquals(calls.length, 2);
  } finally {
    restore();
  }
});

function composioHarness() {
  const executed: Array<Record<string, unknown>> = [];
  const composio = {
    executeTool: (input: Record<string, unknown>) => {
      executed.push(input);
      const slug = String(input.slug);
      if (slug === "YOUTUBE_LIST_COMMENT_THREADS") {
        return Promise.resolve({ successful: true, data: { items: [thread] } });
      }
      if (slug === "YOUTUBE_GET_VIDEO_DETAILS_BATCH") {
        return Promise.resolve({
          successful: true,
          data: { items: [{ id: "v1", snippet: { title: "One" } }] },
        });
      }
      return Promise.resolve({ successful: true, data: { items: [] } });
    },
  };
  const ledger: Array<Record<string, unknown>> = [];
  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: table === "connector_connections"
                  ? {
                    id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
                    workspace_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
                    connector_type: "youtube",
                    toolkit: "youtube",
                    composio_connected_account_id: "ca_1",
                    tool_schema_cache: null,
                    status: "active",
                  }
                  : table === "workspaces"
                  // resolveWorkspaceForCall's personal-workspace fallback.
                  ? { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" }
                  : null,
                error: null,
              }),
          }),
        }),
      }),
      insert: (row: Record<string, unknown>) => {
        ledger.push(row);
        return Promise.resolve({ error: null });
      },
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  const account = {
    ...native,
    auth_provider: "composio",
    access_token: null,
    refresh_token: null,
    connection_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    workspace_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
  };
  return { account, admin, composio, executed, ledger };
}

Deno.test("composio listThreads executes the pinned tool and parses Google's shape", async () => {
  const { account, admin, composio, executed } = composioHarness();
  const result = await listThreads(
    account,
    // deno-lint-ignore no-explicit-any
    { admin, composio: composio as any },
    { channelId: "UC-me" },
  );
  if (!result.ok) throw new Error(result.message);
  assertEquals(executed[0].slug, "YOUTUBE_LIST_COMMENT_THREADS");
  assertEquals(executed[0].version, "20260721_00");
  assertEquals(executed[0].connectedAccountId, "ca_1");
  // Production 2026-09-04: the first live sweep of a Composio channel failed with
  // composio_rejected — 50 threads with replies is 72 KB, over the client's 64 KB body cap.
  assertEquals((executed[0].arguments as Record<string, unknown>).maxResults, 20);
  assertEquals(result.value.items[0].id, "t1");
});

// connector_call_logs.workspace_id is a NOT NULL uuid: a null account
// workspace_id must resolve to the owner's personal workspace, never the
// empty string whose insert threw `invalid input syntax for type uuid: ""`
// on every Composio comment call from 2026-09-03.
Deno.test("a composio call with a null workspace_id ledgeres the owner's personal workspace", async () => {
  const harness = composioHarness();
  const result = await listThreads(
    { ...harness.account, workspace_id: null },
    // deno-lint-ignore no-explicit-any
    { admin: harness.admin, composio: harness.composio as any },
    { channelId: "UC-me" },
  );
  if (!result.ok) throw new Error(result.message);
  assertEquals(harness.ledger.length, 1);
  assertEquals(harness.ledger[0].workspace_id, "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee");
});

// The bug that actually blinded the ledger: connector_call_logs.tool_id is a
// uuid FK to ai_agent_tools, and this path passed the Composio slug into it, so
// every insert died with `invalid input syntax for type uuid:
// "YOUTUBE_LIST_COMMENT_THREADS"`. The slug belongs in action_name, which is
// text. The old harness could not catch this because its fake insert accepted
// anything -- so this asserts the column values, not just that a row was built.
Deno.test("a composio comment call ledgers the slug as action_name and no tool_id", async () => {
  const harness = composioHarness();
  const result = await listThreads(
    harness.account,
    // deno-lint-ignore no-explicit-any
    { admin: harness.admin, composio: harness.composio as any },
    { channelId: "UC-me" },
  );
  if (!result.ok) throw new Error(result.message);
  assertEquals(harness.ledger.length, 1);
  assertEquals(harness.ledger[0].tool_id, null);
  assertEquals(harness.ledger[0].action_name, "YOUTUBE_LIST_COMMENT_THREADS");
});

Deno.test("Composio batch and playlist calls use the verified argument names", async () => {
  const { account, admin, composio, executed } = composioHarness();
  // deno-lint-ignore no-explicit-any
  const deps = { admin, composio: composio as any };
  await videoTitles(account, deps, ["v1"]);
  await listChannelVideos(account, deps, "UCabc");
  assertEquals(executed[0].arguments, { id: ["v1"], parts: ["snippet"] });
  assertEquals(executed[1].arguments, {
    playlistId: "UUabc",
    part: "snippet",
    maxResults: 25,
  });
});

Deno.test("uploadsPlaylistId swaps only the YouTube channel prefix", () => {
  assertEquals(uploadsPlaylistId("UCabc"), "UUabc");
  assertEquals(uploadsPlaylistId("other"), "other");
});
