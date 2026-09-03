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
const thread = {
  id: "t1",
  videoId: "v1",
  parentId: null,
  text: "x",
  authorChannelId: "UC-ann",
  authorName: "Ann",
  authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z",
  likeCount: 0,
  moderationStatus: null,
  totalReplyCount: 0,
  replies: [],
};

function fakeAdmin(inboxCounts: Record<string, number>) {
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
            return Promise.resolve({
              count: inboxCounts[value] ?? 0,
              error: null,
            });
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
    { account: "b", dispatch: true },
  ]);
  assertEquals(summary.polled, 2);
  assertEquals(summary.dispatched, 1);
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
