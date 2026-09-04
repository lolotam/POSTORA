import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deleteComment, hideComment, replyToComment } from "./commentActions.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], body: unknown = { id: "new-1" }, status = 200) {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(status === 204 ? null : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  };
}

const fbAccount = { platform: "facebook", access_token: "tok", platform_user_id: "page", ig_auth_type: null, account_metadata: {} };
const igDirect = { platform: "instagram", access_token: "tok", platform_user_id: "ig", ig_auth_type: "business_login", account_metadata: {} };
const thAccount = { platform: "threads", access_token: "tok", platform_user_id: "th-1", ig_auth_type: null, account_metadata: {} };

// Production incident, 2026-08-22: every Facebook comment reply failed with "Unsupported post
// request ... does not support this operation". A Facebook comment object has no `/replies`
// edge -- replying means posting a comment ON the comment. The previous version of this test
// asserted the `/replies` URL the code happened to build, so it passed throughout while the
// feature was broken against the real API. Verified by hand against Graph v22.0 on the same
// comment: POST /{id}/replies rejected, POST /{id}/comments returned an id.
Deno.test("facebook reply posts to the /comments edge, which is the one Meta accepts", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "Thanks!", fakeFetch(calls));
  assertEquals(result, { success: true, platform_comment_id: "new-1" });
  assertEquals(calls[0].url, "https://graph.facebook.com/v22.0/c1/comments");
});

// Instagram keeps `/replies`, and it is the platform that decides -- not the Graph host. A
// Page-linked Instagram account is served by graph.facebook.com but still needs Instagram's
// edge, so branching on the host instead of the platform would break exactly that account.
Deno.test("instagram replies keep the /replies edge on either graph host", async () => {
  const direct: Call[] = [];
  await replyToComment(igDirect, "c1", "Thanks!", fakeFetch(direct));
  assertEquals(direct[0].url, "https://graph.instagram.com/v22.0/c1/replies");

  const pageLinked: Call[] = [];
  await replyToComment(
    { platform: "instagram", access_token: "tok", platform_user_id: "ig", ig_auth_type: "facebook_page", account_metadata: {} },
    "c1",
    "Thanks!",
    fakeFetch(pageLinked),
  );
  assertEquals(pageLinked[0].url, "https://graph.facebook.com/v22.0/c1/replies");
});

// A hung Graph call used to sit until the isolate's wall-clock limit killed it, which reached
// the caller as a bodiless gateway error. It is reported as a result now, and flagged apart
// from a rejection so the API can answer 504 rather than 422.
Deno.test("an unreachable platform is a flagged failure, not a thrown error", async () => {
  const timeout = async () => {
    throw Object.assign(new Error("signal timed out"), { name: "TimeoutError" });
  };
  const result = await replyToComment(fbAccount, "c1", "Thanks!", timeout as unknown as typeof fetch);
  assertEquals(result.success, false);
  assertEquals(result.upstreamUnavailable, true);

  const refused = async () => {
    throw new TypeError("connection refused");
  };
  const network = await replyToComment(fbAccount, "c1", "Thanks!", refused as unknown as typeof fetch);
  // Both halves matter: the flag alone would still pass if the result came back successful,
  // and commentActionResponse would then answer 200 for a request that never reached Meta.
  assertEquals(network.success, false);
  assertEquals(network.upstreamUnavailable, true);
});

// A rejection is not an unreachable upstream: the platform answered, and its message is worth
// showing. Only the transport failures above may set the flag.
Deno.test("a platform rejection is not flagged as unreachable", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "Thanks!", fakeFetch(calls, { error: { message: "nope" } }, 400));
  assertEquals(result.success, false);
  assertEquals(result.upstreamUnavailable, undefined);
  assertEquals(result.error, "nope");
});

Deno.test("direct-login instagram uses graph.instagram.com and hide uses the `hide` param", async () => {
  const calls: Call[] = [];
  await hideComment(igDirect, "c1", true, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.instagram.com/v22.0/c1?hide=true&access_token=tok");
});

Deno.test("facebook hide uses is_hidden", async () => {
  const calls: Call[] = [];
  await hideComment(fbAccount, "c1", false, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.facebook.com/v22.0/c1?is_hidden=false&access_token=tok");
});

// Production incident, 2026-08-23: n8n replies failed with "media <container id> not found"
// from threads_publish while the same container published fine moments later. Threads builds
// a container asynchronously, so publish must wait for status FINISHED.
Deno.test("threads reply waits for the container to finish before publishing", async () => {
  const calls: Call[] = [];
  const statuses = ["IN_PROGRESS", "FINISHED"];
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const target = String(url);
    if (target.includes("fields=status")) {
      return new Response(JSON.stringify({ status: statuses.shift() }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: target.endsWith("/threads") ? "container-1" : "reply-1" }), { status: 200 });
  };
  const result = await replyToComment(thAccount, "r0", "Hi", fetcher);
  assertEquals(result, { success: true, platform_comment_id: "reply-1" });
  assertEquals(calls.map((c) => c.url.replace(/\?.*$/, "")), [
    "https://graph.threads.net/v1.0/th-1/threads",
    "https://graph.threads.net/v1.0/container-1",
    "https://graph.threads.net/v1.0/container-1",
    "https://graph.threads.net/v1.0/th-1/threads_publish",
  ]);
});

Deno.test("threads reply reports a container that errored instead of publishing it", async () => {
  const fetcher = async (url: RequestInfo | URL) => {
    const target = String(url);
    if (target.includes("fields=status")) {
      return new Response(JSON.stringify({ status: "ERROR", error_message: "Text too long" }), { status: 200 });
    }
    return new Response(JSON.stringify({ id: "container-1" }), { status: 200 });
  };
  const result = await replyToComment(thAccount, "r0", "Hi", fetcher);
  assertEquals(result, { success: false, error: "Threads reply container ERROR." });
});

Deno.test("threads hide uses manage_reply and delete is refused", async () => {
  const calls: Call[] = [];
  await hideComment(thAccount, "r1", true, fakeFetch(calls, { success: true }));
  assertEquals(calls[0].url, "https://graph.threads.net/v1.0/r1/manage_reply");
  const result = await deleteComment(thAccount, "r1", fakeFetch(calls));
  assertEquals(result, { success: false, error: "Threads does not allow deleting other users' replies; use hide instead." });
});

Deno.test("graph errors are surfaced, not thrown", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "x", fakeFetch(calls, { error: { message: "(#10) Permission denied", code: 10 } }, 400));
  assertEquals(result.success, false);
  assertEquals(result.error, "(#10) Permission denied");
});

Deno.test("an unknown platform is refused, not sent to Meta", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(
    { platform: "bluesky", access_token: "tok", platform_user_id: "x", ig_auth_type: null, account_metadata: {} },
    "c1",
    "hi",
    fakeFetch(calls),
  );
  assertEquals(result.success, false);
  assertEquals(calls.length, 0);
});

Deno.test("youtube reply goes through the adapter with the account's provider", async () => {
  const calls: Call[] = [];
  const ytAccount = {
    id: "acc", user_id: "u", platform: "youtube", auth_provider: "native",
    access_token: "tok", refresh_token: "rt",
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    platform_user_id: "UC-me", ig_auth_type: null, account_metadata: {},
  };
  const admin = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: {} }, error: null }) }) }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }) };
  // The adapter first reads the target's snippet (GET) to find the thread's top-level id,
  // then inserts the reply (POST).
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    const body = init?.method === "POST" ? { id: "new-yt" } : { items: [{ id: "t1", snippet: {} }] };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  };
  const result = await replyToComment(ytAccount, "t1", "hi", fetcher, { admin });
  assertEquals(result, { success: true, platform_comment_id: "new-yt" });
  assertEquals(calls.length, 2);
  assertEquals(calls[1].init?.method, "POST");
  assertEquals(calls[1].url.startsWith("https://www.googleapis.com/youtube/v3/comments"), true);
});

Deno.test("youtube hide maps to moderation rejected, unhide to published", async () => {
  const calls: Call[] = [];
  const admin = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: { account_metadata: {} }, error: null }) }) }),
    update: () => ({ eq: () => Promise.resolve({ error: null }) }),
  }) };
  const ytAccount = {
    id: "acc", user_id: "u", platform: "youtube", auth_provider: "native",
    access_token: "tok", refresh_token: "rt",
    token_expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    platform_user_id: "UC-me", ig_auth_type: null, account_metadata: {},
  };
  await hideComment(ytAccount, "t1", true, fakeFetch(calls, null, 204), { admin });
  await hideComment(ytAccount, "t1", false, fakeFetch(calls, null, 204), { admin });
  assertEquals(new URL(calls[0].url).searchParams.get("moderationStatus"), "rejected");
  assertEquals(new URL(calls[1].url).searchParams.get("moderationStatus"), "published");
});
