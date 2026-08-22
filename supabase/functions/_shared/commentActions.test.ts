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

Deno.test("facebook reply posts to /{comment}/replies on graph.facebook.com", async () => {
  const calls: Call[] = [];
  const result = await replyToComment(fbAccount, "c1", "Thanks!", fakeFetch(calls));
  assertEquals(result, { success: true, platform_comment_id: "new-1" });
  assertEquals(calls[0].url, "https://graph.facebook.com/v22.0/c1/replies");
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
