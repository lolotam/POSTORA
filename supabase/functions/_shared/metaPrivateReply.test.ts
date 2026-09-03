import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type PrivateReplyAccount, sendPrivateReply } from "./metaPrivateReply.ts";

const FACEBOOK: PrivateReplyAccount = {
  id: "acct-fb",
  user_id: "user-1",
  platform: "facebook",
  access_token: "page-token",
  platform_user_id: "page-1",
  account_metadata: {},
};

const INSTAGRAM_DIRECT: PrivateReplyAccount = {
  id: "acct-ig",
  user_id: "user-1",
  platform: "instagram",
  access_token: "ig-token",
  platform_user_id: "ig-1",
  ig_auth_type: "business_login",
  account_metadata: {},
};

// Page-backed Instagram: no business_login marker, so the send has to go out through the
// linked Facebook Page rather than graph.instagram.com.
const INSTAGRAM_PAGE_BACKED: PrivateReplyAccount = {
  id: "acct-ig2",
  user_id: "user-1",
  platform: "instagram",
  access_token: "linked-page-token",
  platform_user_id: "ig-2",
  ig_auth_type: null,
  account_metadata: { page_id: "page-9" },
};

function recordingFetch(status = 200, body: unknown = { recipient_id: "r-1", message_id: "m-1" }) {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  const fetcher = (async (url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) });
    return new Response(JSON.stringify(body), { status });
  }) as unknown as typeof fetch;
  return { fetcher, calls };
}

// A Facebook Page and a direct-login Instagram account resolve their credentials without a
// database read at all, so any query here is a bug rather than a missing stub.
const NO_ADMIN = {
  from() {
    throw new Error("the admin client must not be consulted for this account");
  },
};

Deno.test("a Facebook Page posts to /{page-id}/messages with recipient.comment_id", async () => {
  const { fetcher, calls } = recordingFetch();
  const result = await sendPrivateReply(NO_ADMIN, FACEBOOK, "c1", "hello", fetcher);

  assertEquals(result, { success: true, platform_comment_id: "m-1" });
  assertEquals(calls.length, 1);
  assertStringIncludes(calls[0].url, "https://graph.facebook.com/");
  assertStringIncludes(calls[0].url, "/page-1/messages");
  assertEquals(calls[0].body.recipient, { comment_id: "c1" });
  assertEquals(calls[0].body.message, { text: "hello" });
  assertEquals(calls[0].body.access_token, "page-token");
});

Deno.test("a direct-login Instagram account sends as itself on graph.instagram.com", async () => {
  const { fetcher, calls } = recordingFetch();
  await sendPrivateReply(NO_ADMIN, INSTAGRAM_DIRECT, "c9", "hi", fetcher);

  assertStringIncludes(calls[0].url, "https://graph.instagram.com/");
  assertStringIncludes(calls[0].url, "/ig-1/messages");
  assertEquals(calls[0].body.access_token, "ig-token");
});

Deno.test("a page-backed Instagram account sends through its linked Page on graph.facebook.com", async () => {
  const { fetcher, calls } = recordingFetch();
  await sendPrivateReply(NO_ADMIN, INSTAGRAM_PAGE_BACKED, "c3", "hi", fetcher);

  assertStringIncludes(calls[0].url, "https://graph.facebook.com/");
  assertStringIncludes(calls[0].url, "/page-9/messages");
  assertEquals(calls[0].body.access_token, "linked-page-token");
});

Deno.test("a Meta rejection surfaces error_user_msg and never leaks the token", async () => {
  const { fetcher } = recordingFetch(400, {
    error: { message: "(#10) developer text", error_user_msg: "This comment can no longer receive a private reply." },
  });
  const result = await sendPrivateReply(NO_ADMIN, FACEBOOK, "c1", "hello", fetcher);

  assertEquals(result.success, false);
  assertEquals(result.error, "This comment can no longer receive a private reply.");
  assertEquals(JSON.stringify(result).includes("page-token"), false);
});

Deno.test("a 200 with no message id is a failure, not a silent non-delivery", async () => {
  const { fetcher } = recordingFetch(200, { recipient_id: "r-1" });
  const result = await sendPrivateReply(NO_ADMIN, FACEBOOK, "c1", "hello", fetcher);

  assertEquals(result.success, false);
  assertStringIncludes(String(result.error), "no message id");
});

Deno.test("a missing token fails closed without touching the network", async () => {
  const { fetcher, calls } = recordingFetch();
  const result = await sendPrivateReply(NO_ADMIN, { ...FACEBOOK, access_token: null }, "c1", "hello", fetcher);

  assertEquals(result.success, false);
  assertEquals(calls.length, 0);
});

Deno.test("an Instagram account with no resolvable Page reports the reconnect, does not throw", async () => {
  const { fetcher, calls } = recordingFetch();
  const adminWithNoPages = {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            eq: () => Promise.resolve({ data: [], error: null }),
          }),
        }),
      }),
    }),
  };
  const orphan: PrivateReplyAccount = { ...INSTAGRAM_PAGE_BACKED, access_token: "tok", account_metadata: {} };
  const result = await sendPrivateReply(adminWithNoPages, orphan, "c1", "hello", fetcher);

  assertEquals(result.success, false);
  assertStringIncludes(String(result.error), "NO_LINKED_PAGE");
  assertEquals(calls.length, 0);
});
