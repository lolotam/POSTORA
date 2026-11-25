// Stage 4 provider, digest and sealing unit tests.
//
// Every case is offline: a fake fetcher stands in for Google, and the
// assertions pin the classification table of spec 9.2 and 11, the digest
// formulas of 7.2 and the sealed-token rules of 8.2.

import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  insertReply,
  insertThread,
  listRepliesPage,
  listThreadsPage,
  listUploads,
  listVideosDetails,
  readComment,
  readVideo,
  setModerationStatus,
  updateComment,
} from "./provider.ts";
import { normaliseText, computeIntentDigests, computeLogicalDigests } from "./digests.ts";
import {
  BAN_CONFIRMATION_PREFIX,
  CURSOR_PREFIX,
  HANDLE_PREFIX,
  MAX_CURSOR_HOPS,
  sealBanConfirmation,
  sealCursor,
  sealHandle,
  unsealBanConfirmation,
  unsealCursor,
  unsealHandle,
} from "./sealing.ts";

const TEST_SIGNER = "stage4-test-signing-secret";

type Call = { url: string; method: string; body?: unknown };

function fakeFetch(
  handler: (url: string, init?: RequestInit) => { status: number; body: unknown },
) {
  const calls: Call[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const urlText = String(url);
    calls.push({ url: urlText, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const { status, body } = handler(urlText, init);
    return new Response(status === 204 ? null : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return { calls, fetcher };
}

const ACCOUNT = { id: "acc-1", platform_user_id: "UC-test-channel", access_token: "tok" };

Deno.test("listUploads pages the uploads playlist with 25 per page", async () => {
  const { calls, fetcher } = fakeFetch(() => ({
    status: 200,
    body: { items: [{ snippet: { resourceId: { videoId: "v1" }, title: "One" } }], nextPageToken: "next-1" },
  }));
  const res = await listUploads({ fetcher }, ACCOUNT, "tok", { pageToken: "pt-1" });
  assertEquals(res.kind, "success");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/playlistItems");
  assertEquals(url.searchParams.get("part"), "snippet,contentDetails,status");
  assertEquals(url.searchParams.get("playlistId"), "UU-test-channel");
  assertEquals(url.searchParams.get("maxResults"), "25");
  assertEquals(url.searchParams.get("pageToken"), "pt-1");
});

Deno.test("listVideosDetails requests all Studio metadata for at most 50 videos", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
  const videoIds = Array.from({ length: 55 }, (_, index) => `vid-${index + 1}`);
  const res = await listVideosDetails({ fetcher }, "tok", videoIds);
  assertEquals(res.kind, "success");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/videos");
  assertEquals(url.searchParams.get("part"), "snippet,contentDetails,status,statistics,liveStreamingDetails");
  assertEquals(url.searchParams.get("id"), videoIds.slice(0, 50).join(","));
  assertEquals(calls.length, 1);
});

Deno.test("listThreadsPage requests the exact moderationStatus of the list", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
  await listThreadsPage({ fetcher }, ACCOUNT, "tok", { videoId: "vid-1", moderationStatus: "heldForReview" });
  const url = new URL(calls[0].url);
  assertEquals(url.searchParams.get("videoId"), "vid-1");
  assertEquals(url.searchParams.get("moderationStatus"), "heldForReview");
  assertEquals(url.searchParams.get("maxResults"), "20");
});

Deno.test("listRepliesPage pages 50 replies by parent", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { items: [] } }));
  await listRepliesPage({ fetcher }, "tok", { parentId: "top-1" });
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/comments");
  assertEquals(url.searchParams.get("parentId"), "top-1");
  assertEquals(url.searchParams.get("maxResults"), "50");
});

Deno.test("insertThread builds the documented body", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: threadBody() }));
  await insertThread({ fetcher }, "tok", { channelId: "UC-test-channel", videoId: "vid-1", text: "Hello" });
  assertEquals(calls[0].method, "POST");
  const url = new URL(calls[0].url);
  assertEquals(url.pathname, "/youtube/v3/commentThreads");
  assertEquals(calls[0].body, {
    snippet: {
      channelId: "UC-test-channel",
      videoId: "vid-1",
      topLevelComment: { snippet: { textOriginal: "Hello" } },
    },
  });
});

Deno.test("insertReply and updateComment hit the comments endpoint with the right bodies", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 200, body: { id: "c-2", snippet: { parentId: "top-1" } } }));
  await insertReply({ fetcher }, "tok", { parentId: "top-1", text: "reply" });
  assertEquals(calls[0].body, { snippet: { parentId: "top-1", textOriginal: "reply" } });
  assertEquals(calls[0].method, "POST", "comments.insert is a POST");
  await updateComment({ fetcher }, "tok", { commentId: "c-1", text: "edited" });
  assertEquals(calls[1].body, { id: "c-1", snippet: { textOriginal: "edited" } });
  assertEquals(calls[1].method, "PUT", "comments.update is a PUT; a POST would create a new comment");
});

Deno.test("setModerationStatus omits banAuthor entirely unless it is asked for", async () => {
  const { calls, fetcher } = fakeFetch(() => ({ status: 204, body: null }));
  await setModerationStatus({ fetcher }, "tok", { commentId: "c-1", status: "rejected", banAuthor: false });
  let url = new URL(calls[0].url);
  assertEquals(url.searchParams.get("id"), "c-1");
  assertEquals(url.searchParams.get("moderationStatus"), "rejected");
  assertEquals(url.searchParams.has("banAuthor"), false, "plain Reject must not send banAuthor=false");

  await setModerationStatus({ fetcher }, "tok", { commentId: "c-1", status: "rejected", banAuthor: true });
  url = new URL(calls[1].url);
  assertEquals(url.searchParams.get("banAuthor"), "true");
});

// ---- the classification table (spec 9.2, 11) --------------------------------

function envelope(reason: string) {
  return { error: { errors: [{ reason, message: reason }], message: reason } };
}

/** Narrow a provider result to its indeterminate branch or fail the test. */
function indeterminate(res: Awaited<ReturnType<typeof readVideo>>) {
  if (res.kind !== "indeterminate") throw new Error(`expected indeterminate, got ${res.kind}`);
  return res;
}

Deno.test("a 4xx with a Google envelope is a refusal with the mapped reason", async () => {
  const cases: Array<[string, string]> = [
    ["commentsDisabled", "comments_disabled"],
    ["quotaExceeded", "quota"],
    ["ineligibleAccount", "ineligible_account"],
    ["commentTextTooLong", "invalid_text"],
    ["commentTextRequired", "invalid_text"],
  ];
  for (const [reason, expected] of cases) {
    const { fetcher } = fakeFetch(() => ({ status: 403, body: envelope(reason) }));
    const res = await readVideo({ fetcher }, "tok", "v");
    assertEquals(res.kind === "refused" && res.reason, expected, `reason ${reason}`);
  }
});

Deno.test("a 4xx whose error list is empty or holds no error object is indeterminate, not a refusal", async () => {
  for (const errors of [[], [null], ["text"], [[]]]) {
    const { fetcher } = fakeFetch(() => ({ status: 403, body: { error: { errors, message: "x" } } }));
    const res = await readVideo({ fetcher }, "tok", "v");
    assertEquals(res.kind, "indeterminate", JSON.stringify(errors));
    assertEquals(indeterminate(res).providerClass, "http_4xx");
  }
});

Deno.test("a write refused with an error item that names no reason is indeterminate, never a final refusal", async () => {
  for (const errors of [[{}], [{ message: "something" }], [{ reason: "" }], [{ reason: 7 }]]) {
    const { fetcher } = fakeFetch(() => ({ status: 403, body: { error: { errors, message: "x" } } }));
    const res = await insertThread({ fetcher }, "tok", { channelId: "UC", videoId: "v", text: "hello" });
    assertEquals(res.kind, "indeterminate", JSON.stringify(errors));
  }
  // The refusal is classified from the item that names a reason, wherever it sits.
  const { fetcher } = fakeFetch(() => ({ status: 403, body: { error: { errors: [{}, { reason: "quotaExceeded" }], message: "x" } } }));
  const res = await insertThread({ fetcher }, "tok", { channelId: "UC", videoId: "v", text: "hello" });
  assertEquals(res.kind === "refused" && res.reason, "quota");
});

Deno.test("one call is one request: redirects are not followed and a 3xx is indeterminate", async () => {
  let redirectOption: RequestRedirect | undefined;
  let requests = 0;
  const fetcher = ((_url: RequestInfo | URL, init?: RequestInit) => {
    requests += 1;
    redirectOption = init?.redirect;
    return Promise.resolve(new Response(null, { status: 307, headers: { Location: "https://elsewhere.invalid/replay" } }));
  }) as typeof fetch;
  const res = await insertThread({ fetcher }, "tok", { channelId: "UC", videoId: "v", text: "hello" });
  assertEquals(redirectOption, "manual", "the platform is told not to follow redirects");
  assertEquals(requests, 1);
  assertEquals(res.kind, "indeterminate");
  assertEquals(indeterminate(res).status, 307);
});

Deno.test("a 4xx without an envelope is indeterminate, not a refusal", async () => {
  const { fetcher } = fakeFetch(() => ({ status: 403, body: { hello: "world" } }));
  const res = await readVideo({ fetcher }, "tok", "v");
  assertEquals(res.kind, "indeterminate");
  assertEquals(indeterminate(res).providerClass, "http_4xx");
});

Deno.test("a 5xx is always indeterminate, with and without an envelope", async () => {
  for (const body of [envelope("backendError"), null]) {
    const { fetcher } = fakeFetch(() => ({ status: 500, body }));
    const res = await readVideo({ fetcher }, "tok", "v");
    assertEquals(res.kind, "indeterminate");
    assertEquals(indeterminate(res).providerClass, "http_5xx");
  }
});

Deno.test("a network error and a timeout are indeterminate with their own classes", async () => {
  const abortFetcher = (async () => {
    throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
  }) as typeof fetch;
  const res = await readVideo({ fetcher: abortFetcher }, "tok", "v");
  assertEquals(res.kind, "indeterminate");
  assertEquals(indeterminate(res).providerClass, "timeout");

  const networkFetcher = (async () => {
    throw new TypeError("network error");
  }) as typeof fetch;
  const res2 = await readVideo({ fetcher: networkFetcher }, "tok", "v");
  assertEquals(res2.kind, "indeterminate");
  assertEquals(indeterminate(res2).providerClass, "network");
});

Deno.test("204 on moderation is a success carrying the status; any 2xx body is parsed or null", async () => {
  const { fetcher } = fakeFetch(() => ({ status: 204, body: null }));
  const res = await setModerationStatus({ fetcher }, "tok", { commentId: "c", status: "published", banAuthor: false });
  assertEquals(res.kind, "success");
  assertEquals(res.status, 204);
});

// ---- digests (spec 7.2) ------------------------------------------------------

function base64Key(hex: string): string {
  const bytes = new Uint8Array(32);
  for (let i = 0; i < 32; i++) bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return btoa(String.fromCharCode(...bytes));
}

const KEY_1 = base64Key("01".repeat(32));
const KEY_2 = base64Key("02".repeat(32));
const KEYS = { activeVersion: 2, keys: [{ version: 1, key: KEY_1 }, { version: 2, key: KEY_2 }] };

Deno.test("normaliseText is NFC, LF-only and trimmed", () => {
  assertEquals(normaliseText("  hi  "), "hi");
  assertEquals(normaliseText("a\r\nb\rc\rd"), "a\nb\nc\nd");
  assertEquals(normaliseText("\u0065\u0301"), "\u00e9", "e + combining acute composes to é");
  assertEquals(normaliseText("\u00e9"), "\u00e9", "already-NFC text is stable");
});

Deno.test("the intent digest covers the whole intent and moves with any part", async () => {
  const base = {
    action: "create_thread",
    accountId: "acc-1",
    bindingGeneration: 3,
    videoId: "vid-1",
    targetIds: [] as string[],
    moderationStatus: null as string | null,
    banAuthor: false,
    text: "Hello",
  };
  const a = await computeIntentDigests(KEYS, base);
  const b = await computeIntentDigests(KEYS, { ...base, bindingGeneration: 4 });
  const c = await computeIntentDigests(KEYS, base);
  assertEquals(a.version, 2, "the digest is computed under the active version");
  assertEquals(a.digest, c.digest, "the same intent digests identically");
  assertEquals(a.digest !== b.digest, true, "a changed binding changes the intent digest");
});

Deno.test("the logical digest covers channel, video, canonical parent and text only", async () => {
  const parts = { channelId: "UC-x", videoId: "vid-1", canonicalParent: "", text: "Hello" };
  const digests = await computeLogicalDigests(KEYS, parts);
  assertEquals(Object.keys(digests).sort(), ["1", "2"], "a claim carries the digest under every retained version");

  // A reply aimed at a reply uses the top-level comment as its canonical parent,
  // so both replies below are the same logical operation.
  const toReplyA = await computeLogicalDigests(KEYS, { ...parts, canonicalParent: "top-1" });
  const toReplyB = await computeLogicalDigests(KEYS, { ...parts, canonicalParent: "top-1" });
  assertEquals(toReplyA, toReplyB);
  const topLevel = await computeLogicalDigests(KEYS, parts);
  assertEquals(topLevel["1"] !== toReplyA["1"], true, "a top-level comment is a different logical operation");
  // The account row id and the operation key are NOT part of the logical digest.
  const otherAccount = await computeLogicalDigests(KEYS, { ...parts, channelId: "UC-x", videoId: "vid-1", canonicalParent: "", text: "Hello" });
  assertEquals(otherAccount, topLevel);
});

// ---- sealing (spec 8.2) ------------------------------------------------------

Deno.test("handles, cursors and ban confirmations carry distinct prefixes and expiries", async () => {
  const now = 1_000_000;
  const handle = await sealHandle(
    { o: "u1", a: "a1", g: 1, c: "UC", vi: "v", th: "t", co: "c", k: "thread", p: "", au: "", s: "published" },
    { signingSecret: TEST_SIGNER, now, ttlMs: 30 * 60 * 1000 },
  );
  const cursor = await sealCursor(
    { o: "u1", a: "a1", g: 1, vi: "v", l: "published", p: null, a2: "thread_page", h: 1 },
    { signingSecret: TEST_SIGNER, now, ttlMs: 30 * 60 * 1000 },
  );
  const ban = await sealBanConfirmation(
    { o: "u1", a: "a1", g: 1, vi: "v", co: "c", au: "UC-author", op: "op-1" },
    { signingSecret: TEST_SIGNER, now, ttlMs: 120 * 1000 },
  );
  assertEquals(handle.startsWith(HANDLE_PREFIX + "."), true);
  assertEquals(cursor.startsWith(CURSOR_PREFIX + "."), true);
  assertEquals(ban.startsWith(BAN_CONFIRMATION_PREFIX + "."), true);

  assertEquals((await unsealHandle(handle, { signingSecret: TEST_SIGNER, now: now + 1 })) !== null, true);
  assertEquals(await unsealHandle(handle, { signingSecret: "other", now }), null, "a forged signature is refused");
  // Expiry is carried in the payload and named by the caller, so an expired
  // token still unseals for inspection while the handler refuses it.
  const payload = await unsealHandle(handle, { signingSecret: TEST_SIGNER, now: now + 31 * 60 * 1000 });
  assertEquals(payload !== null && payload.e < now + 31 * 60 * 1000, true);
  // A cursor token is not a handle and vice versa.
  assertEquals(await unsealHandle(cursor, { signingSecret: TEST_SIGNER, now }), null);
  assertEquals(await unsealCursor(handle, { signingSecret: TEST_SIGNER, now }), null);
  const banPayload = await unsealBanConfirmation(ban, { signingSecret: TEST_SIGNER, now: now + 121 * 1000 });
  assertEquals(banPayload !== null && banPayload.e < now + 121 * 1000, true, "a ban confirmation is dead at 120 s");
});

Deno.test("a cursor without a hop is structurally invalid, and the cap is a named constant", async () => {
  const now = 1_000_000;
  // The unseal alone does not gate hops — the handler names the refusal — but
  // a cursor sealed without a hop still round-trips, so the handler's hop
  // check is what refuses it (see the handler tests).
  const noHop = await sealCursor(
    { o: "u", a: "a", g: 1, vi: "v", l: "published", p: null, a2: "thread_page", h: 0 },
    { signingSecret: TEST_SIGNER, now, ttlMs: 1000 },
  );
  assertEquals((await unsealCursor(noHop, { signingSecret: TEST_SIGNER, now })) !== null, true);
  // The cap is exported so a page-token cycle dies at a named bound.
  assertEquals(MAX_CURSOR_HOPS >= 100, true);
});

// ---- fixtures ---------------------------------------------------------------

function threadBody() {
  // Deliberately UNEQUAL thread id and top-level comment id: a swapped pair
  // can never reconstruct the parent chain. replies.comments is a TOP-LEVEL
  // member of the commentThreads resource, beside snippet (Google reference).
  return {
    id: "thread-9",
    snippet: {
      videoId: "vid-1",
      channelId: "UC-test-channel",
      topLevelComment: {
        id: "comment-7",
        snippet: {
          authorChannelId: { value: "UC-author-1" },
          authorDisplayName: "Author One",
          textOriginal: "top-level text",
          moderationStatus: "published",
        },
      },
    },
    replies: {
      comments: [
        {
          id: "comment-8",
          snippet: {
            parentId: "comment-7",
            authorChannelId: { value: "UC-test-channel" },
            textOriginal: "a reply by the channel",
          },
        },
      ],
    },
  };
}

Deno.test("the thread fixture keeps thread and top-level ids apart", () => {
  const body = threadBody();
  assertEquals(body.id, "thread-9");
  assertEquals(body.snippet.topLevelComment.id, "comment-7");
  assertEquals(body.replies.comments[0].snippet.parentId, "comment-7");
});
