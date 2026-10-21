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

function deps(
  fetcher: typeof fetch,
  overrides: Partial<PlatformDeleteDeps> = {},
): PlatformDeleteDeps {
  return { fetcher, youtubeDeps: fakeYoutubeDeps, ...overrides };
}

// A fetcher whose headers arrive and whose body never does: the stream is
// opened and nothing is ever enqueued into it, so reading the body waits for
// an answer that never comes. The stream records that it was cancelled, so a
// test can tell whether the connection was released after the deadline.
function stalledBodyFetcher(): {
  fetcher: typeof fetch;
  wasCancelled: () => boolean;
} {
  const state = { cancelled: false };
  const fetcher = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            // Nothing is enqueued and the pull never finishes, so the body
            // never arrives.
            return new Promise<void>(() => {});
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  return { fetcher, wasCancelled: () => state.cancelled };
}

// A fetcher whose headers arrive only after most of the deadline of the call
// has passed, and whose body never arrives. The call must give up at the end
// of the deadline it was given, and not a deadline later.
function slowHeadersStalledBodyFetcher(delayMs: number): {
  fetcher: typeof fetch;
  wasCancelled: () => boolean;
} {
  const state = { cancelled: false };
  const fetcher = (() =>
    new Promise<Response>((resolve) => {
      setTimeout(() => {
        resolve(
          new Response(
            new ReadableStream({
              pull() {
                return new Promise<void>(() => {});
              },
              cancel() {
                state.cancelled = true;
              },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
        );
      }, delayMs);
    })) as unknown as typeof fetch;
  return { fetcher, wasCancelled: () => state.cancelled };
}

// A fetcher that answers with a status and a body that is never read. The
// stream records that it was cancelled, so a test can tell whether the
// connection was released after the answer.
function answerWithUnreadBodyFetcher(status: number): {
  fetcher: typeof fetch;
  wasCancelled: () => boolean;
} {
  const state = { cancelled: false };
  const fetcher = (() =>
    Promise.resolve(
      new Response(
        new ReadableStream({
          pull() {
            return new Promise<void>(() => {});
          },
          cancel() {
            state.cancelled = true;
          },
        }),
        { status, headers: { "Content-Type": "application/json" } },
      ),
    )) as unknown as typeof fetch;
  return { fetcher, wasCancelled: () => state.cancelled };
}

// The Graph answer of a delete of an object that Graph cannot confirm: a 400
// with the code 100 and the subcode 33, and not a 404. Meta uses the code for
// an object that does not exist, for one that cannot be loaded with the
// permissions of this connection, and for one that does not support the
// operation, so the answer says nothing certain about the object.
function goneFromGraph(): QueuedResponse {
  return {
    status: 400,
    body: {
      error: {
        message: `Object with ID '${PLATFORM_POST_ID}' does not exist`,
        type: "GraphMethodException",
        code: 100,
        error_subcode: 33,
      },
    },
  };
}

function row(overrides: Partial<PublishedPlatformPost> = {}): PublishedPlatformPost {
  return {
    id: ROW,
    platform: "facebook",
    platform_post_id: PLATFORM_POST_ID,
    social_account_id: ACCOUNT,
    response_data: null,
    post_metadata: null,
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

Deno.test("a facebook post that is not there any more is a delete that already happened", async () => {
  const { fetcher } = fakeFetcher([
    { status: 404, body: { error: { message: "Unsupported get request." } } },
  ]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
});

Deno.test("a facebook 404 releases the body of the answer", async () => {
  // The body of a 404 is never read, so it is released: the connection to
  // the platform must not stay open behind the answer the caller got.
  const { fetcher, wasCancelled } = answerWithUnreadBodyFetcher(404);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
  assertEquals(wasCancelled(), true);
});

Deno.test("a facebook post that Graph says does not exist is not reported as deleted", async () => {
  // Graph answers a delete of an object it cannot confirm with a 400, the
  // code 100 and the subcode 33, and not with a 404. The code is ambiguous:
  // the object may be gone, may not be reachable with this connection, or may
  // not support the operation at all. Postora cannot tell the three apart,
  // so the delete is not confirmed and the copy may still be on Facebook.
  const { fetcher } = fakeFetcher([goneFromGraph()]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Facebook says this post does not exist or cannot be reached with this connection, so Postora cannot confirm it was removed. Check Facebook and delete it there if it is still visible.",
  );
});

Deno.test("a facebook post that Graph says does not exist and went out as more than one item is not reported as deleted either", async () => {
  // The answer confirms nothing, so the caller is told where to look: the
  // copy may still be on Facebook, and only the caller can see it.
  const { fetcher } = fakeFetcher([goneFromGraph()]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: ["feed", "story"] } }),
    account(),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Facebook says this post does not exist or cannot be reached with this connection, so Postora cannot confirm it was removed. Check Facebook and delete it there if it is still visible.",
  );
});

Deno.test("a facebook post that is not there any more and went out as more than one item says what is left on Facebook", async () => {
  // The recorded id is gone (a 404 says so), but the story of the same post is
  // not: the caller is still told what is left over on Facebook.
  const { fetcher } = fakeFetcher([
    { status: 404, body: { error: { message: "Unsupported get request." } } },
  ]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: ["feed", "story"] } }),
    account(),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(outcome.reason.includes("2 Facebook items"), true);
  assertEquals(outcome.reason.includes("it was already gone"), true);
  assertEquals(outcome.reason.includes("Delete the others in Facebook."), true);
});

Deno.test("a facebook delete whose answer confirms nothing is a failure", async () => {
  // A 2xx without a confirmation is not a delete: the copy may still be on
  // Facebook, and the caller has to be told so.
  const { fetcher } = fakeFetcher([{ status: 200 }]);
  const outcome = await deletePublishedPost(row(), account(), deps(fetcher));
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Facebook did not confirm the delete.");
});

Deno.test("a facebook delete whose body never arrives is a failure and the connection is released", async () => {
  // The headers arrived and the body did not: the delete could not be
  // confirmed, and the platform is not to be blamed for a refusal it never
  // made.
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const outcome = await deletePublishedPost(
    row(),
    account(),
    deps(fetcher, { providerTimeoutMs: 20 }),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Could not reach Facebook. Try again.");
  // The body is cancelled, so the connection to the platform is released: a
  // platform that stalls must not keep it open behind the answer.
  assertEquals(wasCancelled(), true);
});

Deno.test("a facebook delete whose headers take most of the deadline fails within one deadline", async () => {
  // The headers arrive late and the body never does: the call must give up
  // at the end of the deadline it was given. The body read does not get a
  // deadline of its own, or the call would last twice as long.
  const timeoutMs = 200;
  const { fetcher, wasCancelled } = slowHeadersStalledBodyFetcher(
    Math.round(timeoutMs * 0.8),
  );
  const startedAt = Date.now();
  const outcome = await deletePublishedPost(
    row(),
    account(),
    deps(fetcher, { providerTimeoutMs: timeoutMs }),
  );
  const elapsed = Date.now() - startedAt;

  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Could not reach Facebook. Try again.");
  // One deadline, not two: the body read gets what is left of it.
  assertEquals(elapsed < timeoutMs * 1.4, true);
  assertEquals(wasCancelled(), true);
});

Deno.test("a facebook post that went out as more than one item says what is left on Facebook", async () => {
  // A feed post and a story are two objects on Facebook, and Postora keeps
  // one id for the lot of them. Deleting the recorded id does not delete the
  // story, so the caller has to be told that it is still there.
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: ["feed", "story"] } }),
    account(),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(outcome.reason.includes("2 Facebook items"), true);
  assertEquals(outcome.reason.includes("feed, story"), true);
  assertEquals(outcome.reason.includes("Delete the others in Facebook."), true);
  // The recorded id was still deleted: what is left over is the other item.
  assertEquals(calls.length, 1);
  assertEquals(calls[0].method, "DELETE");
  assertEquals(
    calls[0].url,
    `${FACEBOOK_GRAPH}/${PLATFORM_POST_ID}?access_token=${encodeURIComponent(PLACEHOLDER_CREDENTIAL)}`,
  );
});

Deno.test("a facebook post that went out as one item is deleted as before", async () => {
  // The metadata of an older post carries one type and not a list: there is
  // only one item, so the delete is a delete.
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: "feed" } }),
    account(),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
});

Deno.test("a facebook post that lists the same item twice is one item", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: ["feed", "feed"] } }),
    account(),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
});

Deno.test("a facebook post that went out as more than one item and whose delete failed is a failure", async () => {
  // The delete of the recorded id did not land: that is a failure, and the
  // items that are left over are not what the caller is told about first.
  const { fetcher } = fakeFetcher([
    { status: 400, body: { error: { message: "Unsupported delete request." } } },
  ]);
  const outcome = await deletePublishedPost(
    row({ post_metadata: { facebook_post_type: ["feed", "story"] } }),
    account(),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Unsupported delete request.");
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
  assertEquals(calls[0].method, "DELETE");
});

Deno.test("the threads delete asks Graph whatever the granted scopes are", async () => {
  // The scope check belongs to the connection, not to the delete: a Threads
  // account that carries no scope information is still asked to delete.
  const { calls, fetcher } = fakeFetcher([{ status: 200, body: { success: true } }]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
});

Deno.test("a threads delete the connection may not do is not supported, not failed", async () => {
  for (const code of [10, 200]) {
    const { fetcher } = fakeFetcher([
      {
        status: 403,
        body: {
          error: {
            message: "(#10) Permission denied",
            type: "OAuthException",
            code,
          },
        },
      },
    ]);
    const outcome = await deletePublishedPost(
      row({ platform: "threads" }),
      account({ platform: "threads" }),
      deps(fetcher),
    );
    if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
    assertEquals(outcome.reason, "Reconnect Threads to allow deleting posts.");
  }
});

Deno.test("a threads error that mentions a permission is not supported", async () => {
  const { fetcher } = fakeFetcher([
    {
      status: 400,
      body: {
        error: {
          message: "This app does not have permission to delete this post.",
          type: "OAuthException",
        },
      },
    },
  ]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(outcome.reason, "Reconnect Threads to allow deleting posts.");
});

Deno.test("a threads post that is not there any more is a delete that already happened", async () => {
  const { fetcher } = fakeFetcher([
    { status: 404, body: { error: { message: "Unsupported delete request." } } },
  ]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  assertEquals(outcome, {
    outcome: "deleted",
    note: "Already removed on the platform.",
  });
});

Deno.test("a threads post that Graph says does not exist is not reported as deleted", async () => {
  // Threads answers a delete of an object it cannot confirm with the same
  // 400, the code 100 and the subcode 33 that Facebook answers with. The
  // code is ambiguous, so the delete is not confirmed.
  const { fetcher } = fakeFetcher([goneFromGraph()]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Threads says this post does not exist or cannot be reached with this connection, so Postora cannot confirm it was removed. Check Threads and delete it there if it is still visible.",
  );
});

Deno.test("a threads delete whose answer confirms nothing is a failure", async () => {
  const { fetcher } = fakeFetcher([{ status: 200 }]);
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Threads did not confirm the delete.");
});

Deno.test("a threads delete whose body never arrives is a failure and the connection is released", async () => {
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "threads" }),
    account({ platform: "threads" }),
    deps(fetcher, { providerTimeoutMs: 20 }),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason, "Could not reach Threads. Try again.");
  assertEquals(wasCancelled(), true);
});

Deno.test("instagram and tiktok cannot be deleted on the platform, so nothing is called", async () => {
  for (const [platform, reason] of [
    [
      "instagram",
      "Instagram deletes published media only for Facebook-Login connections with the instagram_manage_contents permission, which Postora does not request yet; remove it in the Instagram app.",
    ],
    [
      "tiktok",
      "TikTok has no API to delete a published post; remove it in the TikTok app.",
    ],
  ] as const) {
    const { calls, fetcher } = fakeFetcher();
    const outcome = await deletePublishedPost(
      row({ platform }),
      account({ platform }),
      deps(fetcher),
    );
    if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
    assertEquals(outcome.reason, reason);
    assertEquals(calls.length, 0);
  }
});

Deno.test("a platform with no deleter at all cannot be deleted on the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "bluesky" }),
    account({ platform: "bluesky" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora cannot delete posts on bluesky yet; remove it in the bluesky app.",
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
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora has no platform post id for this result, so it cannot be deleted on the platform.",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a disconnected account cannot be deleted on the platform", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(row(), null, deps(fetcher));
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
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

Deno.test("a pinterest pin that answers 2xx is a delete even when its body never arrives", async () => {
  // The 2xx is the confirmation: Pinterest says the pin is gone. The body is
  // not read and not needed, so it is released, and a delete that Pinterest
  // confirmed is never turned into a "could not reach".
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "pinterest", platform_post_id: "111" }),
    account({ platform: "pinterest" }),
    deps(fetcher, { providerTimeoutMs: 20 }),
  );
  assertEquals(outcome, { outcome: "deleted" });
  // The body is released, so the connection to Pinterest does not stay open
  // behind the answer.
  assertEquals(wasCancelled(), true);
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
  assertEquals(outcome.reason.includes("Deleted 1 of 2 LinkedIn destinations"), true);
});

Deno.test("a linkedin destination that is gone counts as deleted in the failure report", async () => {
  // The destination that answered 404 is gone, so it is one of the deleted
  // ones: the caller asked for it to be gone and it is.
  const { fetcher } = fakeFetcher([{ status: 404 }, { status: 500 }]);
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
  assertEquals(outcome.reason.includes("Deleted 1 of 2 LinkedIn destinations"), true);
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

Deno.test("a linkedin destination that answers 2xx is a delete even when its body never arrives", async () => {
  // The 2xx is the confirmation: LinkedIn says the copy is gone. The body is
  // not read and not needed, so it is released, and a delete that LinkedIn
  // confirmed is never turned into a "could not reach".
  const { fetcher, wasCancelled } = stalledBodyFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "linkedin" }),
    account({ platform: "linkedin" }),
    deps(fetcher, { providerTimeoutMs: 20 }),
  );
  assertEquals(outcome, { outcome: "deleted" });
  // The body is released, so the connection to LinkedIn does not stay open
  // behind the answer.
  assertEquals(wasCancelled(), true);
});

Deno.test("a linkedin post that went to several destinations says what is left on LinkedIn", async () => {
  // The stored answer of the publish does not keep the list of destinations,
  // so the metadata is what says how many copies are on LinkedIn. The primary
  // URN is the only one Postora recorded.
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      post_metadata: {
        linkedin_destinations: [
          { account_id: ACCOUNT, destination_id: "personal" },
          { account_id: ACCOUNT, destination_id: "77777777-7777-4777-8777-777777777777" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(outcome.reason.includes("2 LinkedIn destinations"), true);
  assertEquals(outcome.reason.includes("Delete the others on LinkedIn."), true);
  // The primary URN was still deleted: what is left over is the other one.
  assertEquals(calls.length, 1);
  assertEquals(
    calls[0].url,
    `https://api.linkedin.com/v2/ugcPosts/${encodeURIComponent(PLATFORM_POST_ID)}`,
  );
  assertEquals(calls[0].method, "DELETE");
});

Deno.test("a linkedin post that went to one destination is deleted as before", async () => {
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      post_metadata: {
        linkedin_destinations: [
          { account_id: ACCOUNT, destination_id: "personal" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
});

Deno.test("a linkedin post whose destinations belong to another account is deleted as before", async () => {
  // The metadata holds the destinations of every account of the post, so only
  // the ones of this account are counted.
  const { calls, fetcher } = fakeFetcher([{ status: 204 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      post_metadata: {
        linkedin_destinations: [
          { account_id: "99999999-9999-4999-8999-999999999999", destination_id: "personal" },
          { account_id: "99999999-9999-4999-8999-999999999999", destination_id: "org" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 1);
});

Deno.test("a linkedin post that went to several destinations and whose delete failed is a failure", async () => {
  const { fetcher } = fakeFetcher([{ status: 500 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      post_metadata: {
        linkedin_destinations: [
          { account_id: ACCOUNT, destination_id: "personal" },
          { account_id: ACCOUNT, destination_id: "77777777-7777-4777-8777-777777777777" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  if (outcome.outcome !== "failed") throw new Error("expected a failure");
  assertEquals(outcome.reason.includes("Deleted 0 of 1 LinkedIn destinations"), true);
});

Deno.test("a linkedin post whose stored answer kept its destinations is deleted as before", async () => {
  // The publish kept the list of destinations, so the delete walks all of them
  // and there is nothing left over to report.
  const { calls, fetcher } = fakeFetcher([{ status: 204 }, { status: 204 }]);
  const outcome = await deletePublishedPost(
    row({
      platform: "linkedin",
      response_data: {
        destinations: [
          { post_id: "urn:li:share:111", status: "success" },
          { post_id: "urn:li:share:222", status: "success" },
        ],
      },
      // The metadata says the same thing, and it changes nothing: the stored
      // answer is the one that knows every copy.
      post_metadata: {
        linkedin_destinations: [
          { account_id: ACCOUNT, destination_id: "personal" },
          { account_id: ACCOUNT, destination_id: "77777777-7777-4777-8777-777777777777" },
        ],
      },
    }),
    account({ platform: "linkedin" }),
    deps(fetcher),
  );
  assertEquals(outcome, { outcome: "deleted" });
  assertEquals(calls.length, 2);
});

Deno.test("a composio youtube channel cannot be deleted through Postora", async () => {
  const { calls, fetcher } = fakeFetcher();
  const outcome = await deletePublishedPost(
    row({ platform: "youtube" }),
    account({ platform: "youtube", auth_provider: "composio", access_token: null }),
    deps(fetcher),
  );
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
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
  if (outcome.outcome !== "not_supported") throw new Error("expected a refusal");
  assertEquals(
    outcome.reason,
    "Postora cannot delete posts on constructor yet; remove it in the constructor app.",
  );
  assertEquals(calls.length, 0);
});
