import { assertEquals } from "jsr:@std/assert@1";
import { FACEBOOK_GRAPH, THREADS_GRAPH } from "../_shared/commentActions.ts";
import type { YouTubeCommentsDeps } from "../_shared/youtubeComments.ts";
import {
  deletePublishedPost,
  type DeleteAccount,
  type PlatformDeleteDeps,
  type PublishedPlatformPost,
} from "./platformPostDelete.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const ROW = "44444444-4444-4444-8444-444444444444";
const PLATFORM_POST_ID = "1234567890";
// One token for the whole suite: a token-looking literal in a test file is a
// secret-shaped string, and a scanner would have to guess whether it is one.
const PLACEHOLDER_CREDENTIAL = "placeholder";

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

interface QueuedResponse {
  status?: number;
  body?: unknown;
  reject?: Error;
}

// Every request is answered from this queue: the suite never reaches a real provider.
function fakeFetcher(responses: QueuedResponse[] = []) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : String((input as Request).url);
    const headers: Record<string, string> = {};
    const raw = init?.headers;
    if (raw) {
      if (raw instanceof Headers) {
        raw.forEach((value, key) => {
          headers[key] = value;
        });
      } else if (Array.isArray(raw)) {
        for (const [key, value] of raw) headers[key] = value;
      } else {
        Object.assign(headers, raw as Record<string, string>);
      }
    }
    calls.push({
      url,
      method: init?.method ?? "GET",
      headers,
      body: typeof init?.body === "string" ? init.body : null,
    });
    const next = queue.shift();
    if (!next) throw new Error(`unexpected request: ${init?.method ?? "GET"} ${url}`);
    if (next.reject) throw next.reject;
    const status = next.status ?? 200;
    const payload = status === 204 || next.body === undefined
      ? null
      : JSON.stringify(next.body);
    return new Response(payload, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { calls, fetcher };
}

// The YouTube adapter writes to social_accounts when it has to refresh a token. This
// fake never refreshes, but it exists so nothing real can be built.
function fakeYoutubeDeps(): YouTubeCommentsDeps {
  const admin = {
    from: () => {
      const builder: Record<string, unknown> = {
        update: () => builder,
        eq: () => builder,
        then: (resolve: (value: unknown) => unknown) => resolve({ error: null }),
      };
      return builder;
    },
  };
  return { admin } as unknown as YouTubeCommentsDeps;
}

function deps(fetcher: typeof fetch): PlatformDeleteDeps {
  return { fetcher, youtubeDeps: fakeYoutubeDeps };
}

function row(overrides: Partial<PublishedPlatformPost> = {}): PublishedPlatformPost {
  return {
    id: ROW,
    platform: "facebook",
    platform_post_id: PLATFORM_POST_ID,
    social_account_id: ACCOUNT,
    response_data: null,
    ...overrides,
  };
}

function account(overrides: Partial<DeleteAccount> = {}): DeleteAccount {
  return {
    id: ACCOUNT,
    user_id: USER,
    platform: "facebook",
    access_token: PLACEHOLDER_CREDENTIAL,
    ...overrides,
  };
}

Deno.test("a facebook delete asks Graph to delete the post and reports it deleted", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(
    calls[0].url,
    `${FACEBOOK_GRAPH}/${PLATFORM_POST_ID}?access_token=${encodeURIComponent(PLACEHOLDER_CREDENTIAL)}`,
  );
});

Deno.test("a transport error never puts the token in the reason", async () => {
  const { fetcher } = fakeFetcher([
    {
      reject: new Error(
        `connection reset: ${FACEBOOK_GRAPH}/${PLATFORM_POST_ID}?access_token=SECRET`,
      ),
    },
  ]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason.includes("SECRET"), false);
  assertEquals(outcome.reason, "Could not reach Facebook. Try again.");
});

Deno.test("a Graph error is reported with Meta's own message", async () => {
  const { fetcher } = fakeFetcher([
    { status: 400, body: { error: { message: "Unsupported delete request." } } },
  ]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Unsupported delete request.");
});

Deno.test("success:false is not a delete", async () => {
  const { fetcher } = fakeFetcher([{ status: 200, body: { success: false } }]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Facebook did not confirm the delete.");
});

Deno.test("threads deletes through the Threads graph", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(
    calls[0].url,
    `${THREADS_GRAPH}/${PLATFORM_POST_ID}?access_token=${encodeURIComponent(PLACEHOLDER_CREDENTIAL)}`,
  );
});

Deno.test("instagram and tiktok have no delete endpoint, so nothing is called", async () => {
  for (const [platform, reason] of [
    [
      "instagram",
      "Instagram's API cannot delete published posts. Delete it in the Instagram app.",
    ],
    [
      "tiktok",
      "TikTok's API cannot delete published videos. Delete it in the TikTok app.",
    ],
  ] as const) {
    const { calls, fetcher } = fakeFetcher();
    const outcome = await deletePublishedPost(
      row({ platform }),
      account({ platform }),
      deps(fetcher),
    );
    if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
    assertEquals(outcome.reason, reason);
    assertEquals(calls.length, 0);
  }
});

Deno.test("a platform with no deleter at all is kept on the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "bluesky" }),
    account({ platform: "bluesky" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora cannot delete bluesky posts on the platform yet. Delete it there directly.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a result with no platform post id cannot be deleted", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform_post_id: null }),
    account(),
    deps(fetcher),
  );
  if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora has no platform post id for this result, so it cannot be deleted on the platform.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a disconnected account cannot be deleted on the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(row(), null, deps(fetcher));
  if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "The facebook account that published this post is no longer connected to Postora, so it cannot be deleted on the platform.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("an account with no access token fails without calling the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row(),
    account({ access_token: null }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(
    outcome.reason,
    "The account has no access token. Reconnect it in Profiles and retry.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a pinterest 204 is a delete", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(
    calls[0].url,
    `https://api.pinterest.com/v5/pins/${PLATFORM_POST_ID}`,
  );
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].headers.Authorization, `Bearer ${PLACEHOLDER_CREDENTIAL}`);
});

Deno.test("a pinterest pin that is not there any more is a delete that already happened", async () => {
  const { fetcher } = fakeFetcher([{ status: 404, body: { message: "Pin not found" } }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
});

Deno.test("a pinterest refusal names the status", async () => {
  const { fetcher } = fakeFetcher([
    { status: 403, body: { message: "Not authorized" } },
  ]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason.includes("403"), true);
});

Deno.test("a pinterest post with one pin makes one call", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].url, "https://api.pinterest.com/v5/pins/111");
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[0].headers.Authorization, `Bearer ${PLACEHOLDER_CREDENTIAL}`);
});

Deno.test("a pinterest post with several pins deletes every pin on its own", async () => {
  // One pin per image: the publish keeps every pin id in one comma-joined string.
  const { calls, fetcher } = fakeFetcher([{ status: 204 }, { status: 204 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111,222" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 2);
  assertEquals(calls[0].url, "https://api.pinterest.com/v5/pins/111");
  assertEquals(calls[1].url, "https://api.pinterest.com/v5/pins/222");
  assertEquals(calls[0].method, "DELETE");
  assertEquals(calls[1].method, "DELETE");
});

Deno.test("a pinterest post that only deleted one of its pins is a failure", async () => {
  const { fetcher } = fakeFetcher([{ status: 204 }, { status: 500 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111,222" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason.includes("Deleted 1 of 2 Pinterest pins"), true);
  assertEquals(outcome.reason.includes("222: Pinterest returned 500"), true);
});

Deno.test("a pinterest post whose pins are all gone is a delete that already happened", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 404 }, { status: 404 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111,222" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
  assertEquals(calls.length, 2);
});

Deno.test("a pinterest pin that cannot be reached is a failure that names the pin", async () => {
  const { fetcher } = fakeFetcher([{ reject: new Error("connection reset") }]);
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111,222" }),
    account({ platform: "pinterest" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason.includes("Deleted 0 of 2 Pinterest pins"), true);
  assertEquals(outcome.reason.includes("111: could not reach Pinterest"), true);
});

Deno.test("a linkedin post with two destinations deletes both ugcPosts", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 204 }, { status: 204 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      response_data: {
        destinations: [
          {
            destination_id: "personal",
            urn: "urn:li:person:me",
            post_id: "urn:li:share:111",
            status: "success",
          },
          {
            destination_id: "org",
            urn: "urn:li:organization:222",
            post_id: "urn:li:share:222",
            status: "success",
          },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 2);
  assertEquals(
    calls[0].url,
    "https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A111",
  );
  assertEquals(
    calls[1].url,
    "https://api.linkedin.com/v2/ugcPosts/urn%3Ali%3Ashare%3A222",
  );
  assertEquals(calls[0].headers["X-Restli-Protocol-Version"], "2.0.0");
  assertEquals(calls[1].headers["X-Restli-Protocol-Version"], "2.0.0");
});

Deno.test("a linkedin post that only deleted one destination is a failure", async () => {
  const { fetcher } = fakeFetcher([{ status: 204 }, { status: 500 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      response_data: {
        destinations: [
          { post_id: "urn:li:share:111", status: "success" },
          { post_id: "urn:li:share:222", status: "success" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(
    outcome.reason.includes("Deleted 1 of 2 LinkedIn destinations"),
    true,
  );
});

Deno.test("a linkedin destination that is not there any more is a delete that already happened", async () => {
  const { fetcher } = fakeFetcher([{ status: 404 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "linkedin" }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
});

Deno.test("a composio youtube channel is kept on the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "youtube" }),
    account({ platform: "youtube", auth_provider: "composio", access_token: null }),
    deps(fetcher),
  );
  if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "This YouTube channel is connected through Composio, which cannot delete videos through Postora. Delete it in YouTube Studio.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a native youtube channel deletes the video through the data api", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "youtube" }),
    account({
      platform: "youtube",
      auth_provider: "native",
      access_token: PLACEHOLDER_CREDENTIAL,
      // Far enough in the future that the token is never refreshed.
      token_expires_at: "2099-01-01T00:00:00.000Z",
    }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(
    calls[0].url,
    `https://www.googleapis.com/youtube/v3/videos?id=${PLATFORM_POST_ID}`,
  );
});

Deno.test("a youtube video that is not there any more is a delete that already happened", async () => {
  const { fetcher } = fakeFetcher([
    { status: 404, body: { error: { message: "Video not found." } } },
  ]);
  const outcome = await deletePublishedPost(
    row({ platform: "youtube" }),
    account({
      platform: "youtube",
      auth_provider: "native",
      access_token: PLACEHOLDER_CREDENTIAL,
      // Far enough in the future that the token is never refreshed.
      token_expires_at: "2099-01-01T00:00:00.000Z",
    }),
    deps(fetcher),
  );
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
});

Deno.test("a platform name that is an inherited object key has no deleter", async () => {
  // "constructor" is on Object.prototype, so a plain registry lookup would find
  // one and call it. It must be treated as an unknown platform instead.
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "constructor" }),
    account({ platform: "constructor" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "kept_on_platform") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora cannot delete constructor posts on the platform yet. Delete it there directly.",
  );
  assertEquals(calls.length, 0);
});
