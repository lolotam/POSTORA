import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import { CommentOpError, getComment, listComments, requireCommentCapability, resolveComment } from "./commentOps.ts";
import { YOUTUBE_COMMENT_SCOPE } from "./youtubeCommentCapability.ts";

const ID = "22222222-2222-4222-8222-222222222222";
const OTHER = "11111111-1111-4111-8111-111111111111";
const POST = "33333333-3333-4333-8333-333333333333";
const ACCOUNT = { id: ID, workspace_id: "ws", platform: "facebook", platform_user_id: "page", access_token: "secret", is_active: true };
const ROW = { id: "comment", message: "Hello", created_time: "2026-09-10T00:00:00Z" };
const signingSecret = "test-only-comment-reference-secret";
function fixture(opts: { fail?: string; account?: Record<string, unknown>; missingPost?: boolean } = {}) {
  const reads: URL[] = [];
  const provider: URL[] = [];
  const admin = createClient("https://database.example", "test", { auth: { persistSession: false }, global: { fetch: (input) => {
    const url = new URL(String(input)); reads.push(url);
    const table = url.pathname.split("/").at(-1)!;
    if (table === opts.fail) return Promise.resolve(Response.json({ message: "private db failure" }, { status: 500 }));
    const rows: Record<string, unknown> = {
      social_accounts: [{ ...ACCOUNT, ...opts.account }],
      partner_api_posts: opts.missingPost ? [] : [{ post_id: POST }],
      platform_posts: [{ social_account_id: ID, platform_post_id: "provider-post" }],
    };
    assert(Object.hasOwn(rows, table), table);
    return Promise.resolve(Response.json(rows[table]));
  } } });
  const fetcher: typeof fetch = (input) => {
    const url = new URL(String(input)); provider.push(url);
    if (url.pathname.endsWith("/feed") || url.pathname.endsWith("/media")) return Promise.resolve(Response.json({ data: [{ id: "provider-post" }] }));
    if (url.pathname.endsWith("/comments")) return Promise.resolve(Response.json({ data: [ROW] }));
    return Promise.resolve(Response.json(ROW));
  };
  return { ctx: { admin, workspaceId: "ws", accountIds: [ID], requestId: "req" }, deps: { fetcher, signingSecret }, reads, provider };
}
const request = (query = "") => new Request(`https://partner.example/v1/comments${query}`);

Deno.test("live comment references refuse unbound, foreign and forged targets before provider calls", async () => {
  const f = fixture();
  const first = await listComments(f.ctx, request(), {}, f.deps);
  const id = first.data[0].id;
  f.provider.length = 0; f.reads.length = 0;
  for (const [ctx, target] of [
    [{ ...f.ctx, accountIds: [OTHER] }, id],
    [{ ...f.ctx, workspaceId: "other" }, id],
    [f.ctx, `${id}tampered`],
    [f.ctx, "comment"],
  ] as const) {
    const error = await assertRejects(() => getComment(ctx, target, f.deps), CommentOpError);
    assertEquals(error.code, "resource_not_found");
  }
  assertEquals(f.provider.length, 0); assertEquals(f.reads.length, 0);
  const value = await getComment(f.ctx, id, f.deps);
  assertEquals(value.text, "Hello"); assertEquals(value.id, id);
  assertEquals(f.reads[0].searchParams.get("workspace_id"), "eq.ws");
  assertEquals(f.reads[0].searchParams.get("id"), `in.(${ID})`);
  assert(!f.reads[0].searchParams.get("select")!.split(",").includes("user_id"));
});

for (const fail of ["social_accounts", "partner_api_posts", "platform_posts"]) {
  Deno.test(`failed ${fail} read cannot become an empty comments page`, async () => {
    const f = fixture({ fail });
    const error = await assertRejects(() => listComments(f.ctx, request(), { postId: `post_${POST}` }, f.deps), CommentOpError);
    assertEquals(error.code, "internal_error"); assertEquals(f.provider.length, 0);
  });
}
Deno.test("platform and Postora post filters narrow the live provider request with workspace proof", async () => {
  const f = fixture();
  const result = await listComments(f.ctx, request(), { platform: "facebook", postId: `post_${POST}` }, f.deps);
  assertEquals(result.data[0].platform_post_id, "provider-post");
  assertEquals(f.provider.length, 1);
  assertEquals(f.provider[0].pathname, "/v22.0/provider-post/comments");
  assertEquals(f.provider[0].searchParams.get("filter"), "stream");
  const binding = f.reads.find((u) => u.pathname.endsWith("/partner_api_posts"))!;
  assertEquals(binding.searchParams.get("workspace_id"), "eq.ws");
  const targets = f.reads.find((u) => u.pathname.endsWith("/platform_posts"))!;
  assertEquals(targets.searchParams.get("social_account_id"), `in.(${ID})`);
  assertEquals(targets.searchParams.get("social_accounts.workspace_id"), "eq.ws");
  f.provider.length = 0;
  assertEquals((await listComments(f.ctx, request(), { platform: "instagram" }, f.deps)).data, []);
  assertEquals(f.provider.length, 0);
});
Deno.test("unbound account and outside-workspace post filters refuse without contacting a provider", async () => {
  const f = fixture({ missingPost: true });
  for (const filters of [{ accountId: OTHER }, { postId: `post_${POST}` }]) {
    const error = await assertRejects(() => listComments(f.ctx, request(), filters, f.deps), CommentOpError);
    assertEquals(error.code, "resource_not_found");
  }
  assertEquals(f.provider.length, 0);
});
Deno.test("provider continuation preserves equal-timestamp comments, empty pages, and filters", async () => {
  const f = fixture();
  const cursors: (string | null)[] = [];
  const deps = { ...f.deps, fetcher: ((input) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith("/feed")) return Promise.resolve(Response.json({ data: [{ id: "post" }] }));
    const after = url.searchParams.get("after"); cursors.push(after);
    const data = after === "empty" ? [] : [{ ...ROW, id: after === "last" ? "second" : "first" }];
    return Promise.resolve(Response.json({ data, ...(after !== "last" ? { paging: { next: "https://untrusted.example/?access_token=secret", cursors: { after: after ? "last" : "empty" } } } : {}) }));
  }) as typeof fetch };
  const first = await listComments(f.ctx, request("?limit=1"), {}, deps);
  assert(first.next_cursor); assertEquals(first.data[0].platform_comment_id, "first");
  const second = await listComments(f.ctx, request(`?limit=1&cursor=${first.next_cursor}`), {}, deps);
  assert(second.next_cursor); assertEquals(second.data, []);
  const last = await listComments(f.ctx, request(`?limit=1&cursor=${second.next_cursor}`), {}, deps);
  assertEquals(last.data[0].platform_comment_id, "second"); assertEquals(last.next_cursor, null);
  assertEquals(cursors, [null, "empty", "last"]);
  const error = await assertRejects(() => listComments(f.ctx, request(`?cursor=${first.next_cursor}`), { platform: "facebook" }, deps), CommentOpError);
  assertEquals(error.code, "invalid_request");
});
Deno.test("Graph errors and malformed pages are failures, never empty collections", async () => {
  const f = fixture();
  for (const payload of [{ error: { message: "denied" } }, { unexpected: [] }]) {
    const error = await assertRejects(() => listComments(f.ctx, request(), {}, { ...f.deps, fetcher: () => Promise.resolve(Response.json(payload)) }), CommentOpError);
    assertEquals(error.code, "meta_error");
  }
});
Deno.test("direct Instagram reads use the Instagram host and its comment fields", async () => {
  const f = fixture({ account: { platform: "instagram", ig_auth_type: "business_login" } });
  await listComments(f.ctx, request(), { platform: "instagram" }, f.deps);
  assertEquals(f.provider[0].hostname, "graph.instagram.com");
  assertEquals(f.provider[0].pathname, "/v22.0/page/media");
  assert(f.provider[1].searchParams.get("fields")!.includes("timestamp"));
});
for (const [patch, action, expected] of [
  [{ platform: "youtube", account_metadata: {} }, "get_comment", "account_needs_reauth"],
  [{ platform: "youtube", account_metadata: { granted_scopes: [YOUTUBE_COMMENT_SCOPE] } }, "delete_comment", "unsupported_capability"],
  [{ platform: "threads" }, "reply_comment", "unsupported_capability"],
  [{ is_active: false }, "hide_comment", "account_not_connected"],
] as const) {
  Deno.test(`comment capability: ${JSON.stringify(patch)} ${action} refuses ${expected}`, async () => {
    const f = fixture({ account: patch });
    // Capability gate is synchronous and runs before all provider reads/writes.
    let code: string | undefined;
    try { requireCommentCapability({ ...ACCOUNT, ...patch }, action); }
    catch (error) { code = (error as CommentOpError).code; }
    assertEquals(code, expected); assertEquals(f.provider.length, 0);
  });
}
Deno.test("YouTube honors provider page tokens and returns signed native comment references", async () => {
  const f = fixture({ account: { platform: "youtube", token_expires_at: "2099-01-01T00:00:00Z", account_metadata: { granted_scopes: [YOUTUBE_COMMENT_SCOPE] } } });
  const calls: URL[] = [];
  const deps = { ...f.deps, fetcher: ((input) => {
    const url = new URL(String(input)); calls.push(url);
    return Promise.resolve(Response.json({ items: [{ id: "thread", snippet: { videoId: "video", topLevelComment: { id: "root", snippet: { videoId: "video", textDisplay: "YouTube", publishedAt: ROW.created_time } } } }], ...(url.searchParams.has("pageToken") ? {} : { nextPageToken: "google-next" }) }));
  }) as typeof fetch };
  const first = await listComments(f.ctx, request("?limit=1"), {}, deps);
  assertEquals(first.data[0].platform_comment_id, "root");
  const next = await listComments(f.ctx, request(`?limit=1&cursor=${first.next_cursor}`), {}, deps);
  assertEquals(next.next_cursor, null); assertEquals(calls[1].searchParams.get("pageToken"), "google-next");
  const resolved = await resolveComment(f.ctx, first.data[0].id, deps);
  requireCommentCapability({ ...resolved.account, auth_provider: "composio", account_metadata: {} }, "reply_comment");
});
