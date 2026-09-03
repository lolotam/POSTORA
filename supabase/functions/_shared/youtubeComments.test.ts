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

function fakeAdmin() {
  const updates: Array<Record<string, unknown>> = [];
  return {
    updates,
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () =>
            Promise.resolve({
              data: {
                account_metadata: {
                  granted_scopes: [
                    "https://www.googleapis.com/auth/youtube.force-ssl",
                  ],
                },
              },
              error: null,
            }),
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
  id: "acc",
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

Deno.test("replyToThread posts comments.insert with the parent id", async () => {
  const { calls, fetcher } = fakeFetch(() => ({
    status: 200,
    body: { id: "new" },
  }));
  const result = await replyToThread(
    native,
    { admin: fakeAdmin(), fetcher },
    "t1",
    "thanks",
  );
  assertEquals(result, { ok: true, value: { id: "new" } });
  assertEquals(JSON.parse(String(calls[0].init?.body)), {
    snippet: { parentId: "t1", textOriginal: "thanks" },
  });
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

Deno.test("only invalid_grant marks token health; a transient refresh failure writes nothing", async () => {
  const originalFetch = globalThis.fetch;
  try {
    const expired = { ...native, token_expires_at: new Date(0).toISOString() };

    const transientAdmin = fakeAdmin();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "temporarily_unavailable" }), {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const transient = await listThreads(expired, { admin: transientAdmin }, {
      channelId: "UC-me",
    });
    assertEquals(transient.ok, false);
    assertEquals(transientAdmin.updates, []);

    const invalidAdmin = fakeAdmin();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
      )) as typeof fetch;
    const invalid = await listThreads(expired, { admin: invalidAdmin }, {
      channelId: "UC-me",
    });
    assertEquals(invalid.ok, false);
    assertEquals(invalidAdmin.updates[0].needs_reauth, true);
    assertEquals(
      invalidAdmin.updates[0].last_refresh_error,
      "YouTube refresh failed: invalid_grant",
    );
  } finally {
    globalThis.fetch = originalFetch;
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
  const admin = {
    from: (table: string) => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            maybeSingle: () =>
              Promise.resolve({
                data: table === "connector_connections"
                  ? {
                    id: "conn",
                    workspace_id: "ws",
                    connector_type: "youtube",
                    toolkit: "youtube",
                    composio_connected_account_id: "ca_1",
                    tool_schema_cache: null,
                    status: "active",
                  }
                  : null,
                error: null,
              }),
          }),
        }),
      }),
      insert: () => Promise.resolve({ error: null }),
      update: () => ({ eq: () => Promise.resolve({ error: null }) }),
    }),
  };
  const account = {
    ...native,
    auth_provider: "composio",
    access_token: null,
    refresh_token: null,
    connection_id: "conn",
    workspace_id: "ws",
  };
  return { account, admin, composio, executed };
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
  assertEquals(result.value.items[0].id, "t1");
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
