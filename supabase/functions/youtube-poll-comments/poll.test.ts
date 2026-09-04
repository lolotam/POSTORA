import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { pollYouTubeComments } from "./poll.ts";

const SCOPES = ["https://www.googleapis.com/auth/youtube.force-ssl"];
const rows = [
  {
    id: "a",
    user_id: "u",
    platform: "youtube",
    platform_user_id: "UC-a",
    auth_provider: "native",
    access_token: "t",
    refresh_token: "r",
    token_expires_at: null,
    account_metadata: {
      comment_automation_handler: "internal",
      granted_scopes: SCOPES,
    },
  },
  {
    id: "b",
    user_id: "u",
    platform: "youtube",
    platform_user_id: "UC-b",
    auth_provider: "native",
    access_token: "t",
    refresh_token: "r",
    token_expires_at: null,
    account_metadata: {
      comment_automation_handler: "n8n",
      granted_scopes: SCOPES,
    },
  },
];
const rawThread = { kind: "youtube#commentThread", id: "t1" };
const rawReply = { kind: "youtube#comment", id: "r1" };
const thread = {
  id: "t1",
  raw: rawThread,
  videoId: "v1",
  parentId: null,
  text: "x",
  authorChannelId: "UC-ann",
  authorName: "Ann",
  authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z",
  likeCount: 0,
  moderationStatus: null,
  totalReplyCount: 1,
  replies: [{
    id: "r1",
    raw: rawReply,
    videoId: "v1",
    parentId: "t1",
    text: "y",
    authorChannelId: "UC-bob",
    authorName: "Bob",
    authorAvatar: null,
    publishedAt: "2026-09-01T01:00:00Z",
    likeCount: 0,
    moderationStatus: null,
  }],
};

// A count of `throws` makes the inbox query reject, the way a lost connection would.
function fakeAdmin(inboxCounts: Record<string, number | "throws">) {
  return {
    from: (table: string) => ({
      select: (_columns: string, options?: { count?: string }) => ({
        eq: (_column: string, value: string) => {
          if (table === "social_accounts") {
            return {
              eq: () => Promise.resolve({ data: rows, error: null }),
            };
          }
          if (table === "social_inbox_events" && options?.count) {
            const count = inboxCounts[value] ?? 0;
            if (count === "throws") {
              return Promise.reject(new Error("connection reset"));
            }
            return Promise.resolve({ count, error: null });
          }
          return Promise.resolve({ data: [], error: null });
        },
      }),
    }),
  };
}

Deno.test("first pass over a channel seeds without dispatching; a seen channel dispatches", async () => {
  const ingested: Array<{ account: string; dispatch: boolean | undefined }> =
    [];
  const summary = await pollYouTubeComments(fakeAdmin({ a: 0, b: 3 }), {
    youtube: { admin: null },
    listThreads: async () => ({
      ok: true,
      value: { items: [thread], nextPageToken: null },
    }),
    ingest: async (_admin, account, _platform, _comment, options) => {
      ingested.push({ account: account.id, dispatch: options.dispatch });
      return options.dispatch === false ? "seeded" : "dispatched_n8n";
    },
  });
  assertEquals(ingested, [
    { account: "a", dispatch: false },
    { account: "a", dispatch: false },
    { account: "b", dispatch: true },
    { account: "b", dispatch: true },
  ]);
  assertEquals(summary.polled, 2);
  assertEquals(summary.dispatched, 2);
});

Deno.test("the inbox row stores the Google item that was ingested: the thread for a top-level comment, the reply item for a reply", async () => {
  const stored: Array<{ id: string; raw: unknown }> = [];
  await pollYouTubeComments(fakeAdmin({ a: 1, b: 1 }), {
    youtube: { admin: null },
    listThreads: async (account) => ({
      ok: true,
      value: {
        items: account.id === "a" ? [thread] : [],
        nextPageToken: null,
      },
    }),
    ingest: async (_admin, _account, _platform, comment, options) => {
      stored.push({ id: comment.comment.id, raw: options.rawPayload });
      return "duplicate";
    },
  });
  assertEquals(stored, [
    { id: "t1", raw: rawThread },
    { id: "r1", raw: rawReply },
  ]);
});

Deno.test("a thrown inbox count on one channel is counted as failed and the sweep continues", async () => {
  const polled: string[] = [];
  const summary = await pollYouTubeComments(fakeAdmin({ a: "throws", b: 1 }), {
    youtube: { admin: null },
    listThreads: async (account) => {
      polled.push(account.id);
      return { ok: true, value: { items: [], nextPageToken: null } };
    },
    ingest: async () => "duplicate",
  });
  assertEquals(polled, ["b"]);
  assertEquals(summary.skipped.failed, 1);
});

Deno.test("a quota failure on one channel is counted and the sweep continues", async () => {
  let calls = 0;
  const summary = await pollYouTubeComments(fakeAdmin({ a: 1, b: 1 }), {
    youtube: { admin: null },
    listThreads: async (account) => {
      calls += 1;
      return account.id === "a"
        ? { ok: false, kind: "quota", message: "q" }
        : { ok: true, value: { items: [], nextPageToken: null } };
    },
    ingest: async () => "duplicate",
  });
  assertEquals(calls, 2);
  assertEquals(summary.skipped.quota, 1);
});
