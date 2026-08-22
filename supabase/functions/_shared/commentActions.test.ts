import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deleteComment, hideComment, replyToComment } from "./commentActions.ts";

type Call = { url: string; init?: RequestInit };
function fakeFetch(calls: Call[], body: unknown = { id: "new-1" }, status = 200) {
  return async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
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

Deno.test("threads reply creates a container then publishes", async () => {
  const calls: Call[] = [];
  let n = 0;
  const fetcher = async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    n += 1;
    return new Response(JSON.stringify({ id: n === 1 ? "container-1" : "reply-1" }), { status: 200 });
  };
  const result = await replyToComment(thAccount, "r0", "Hi", fetcher);
  assertEquals(result, { success: true, platform_comment_id: "reply-1" });
  assertEquals(calls[0].url, "https://graph.threads.net/v1.0/th-1/threads");
  assertEquals(calls[1].url, "https://graph.threads.net/v1.0/th-1/threads_publish");
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
