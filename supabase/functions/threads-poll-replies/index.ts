// Threads reply poller — cron-invoked, service role, no user auth.
//
// Why this exists: Threads is the only connected platform whose inbound comments cannot be
// relied on to arrive by webhook. Its Webhooks product exposes only `replies` and `delete`,
// the `replies` field has never delivered for this deployment, and mentions have no webhook
// field at all (`threads_manage_mentions` only unlocks the `GET /me/mentions` read). Postora
// could always *see* those replies — the Reply Center reads them from Graph when you open the
// page — but a page view is not an event, so nothing ever reached an n8n subscription.
//
// This closes that gap by making Postora itself the source of the event: poll, dedupe, then
// hand each new comment to the same ingest door the webhook uses. If Meta ever does start
// delivering, the two coexist: whichever sees a reply first claims it, the other no-ops.
//
// Endpoint choice is not interchangeable and was verified against the live API:
//   GET /{threads-user-id}/replies  -> only replies the ACCOUNT ITSELF wrote. Useless here.
//   GET /{threads-media-id}/conversation -> the full reply tree under one post, other people
//                                           included, nested replies included.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { corsHeaders } from "../_shared/cors.ts";
import { verifyCronAuth } from "../_shared/cron-auth.ts";
import { resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { ingestThreadsComment } from "../_shared/threadsCommentIngest.ts";
import { metaGet, STANDARD_REPLY_FIELDS } from "../_shared/threads-reply-helpers.ts";
import { normalizeThreadsReply } from "../threads-webhook/replyEvents.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// One Graph call per post per run, so the page size is the cost knob -- and the only one.
//
// This used to also drop posts older than two days, which silently made the poller blind:
// people reply to a post for far longer than the post stays recent, and an account whose
// newest post has aged past the window stopped receiving replies entirely while its
// mentions kept arriving (mentions are read separately and never had a window). Verified
// in production 2026-08-27 -- an account whose only post was five days old had two
// unanswered customer replies sitting in `/conversation` that no run would ever read.
//
// Removing it does not raise the ceiling, only the typical case: `/me/threads` already
// returns at most MAX_POSTS_PER_ACCOUNT, most recent first, and `has_replies` still drops
// the posts nobody answered. Worst case is (cap + 2) calls per run against a quota measured
// at 1% by `x-business-use-case-usage` at current volume.
const MAX_POSTS_PER_ACCOUNT = 15;
const ACCOUNT_SELECT =
  "id, user_id, platform, platform_user_id, platform_username, access_token, account_metadata";

interface ThreadsAccount {
  id: string;
  user_id: string;
  platform: string;
  platform_user_id: string | null;
  platform_username: string | null;
  access_token: string | null;
  account_metadata: Record<string, unknown> | null;
}

/** Posts worth asking about: recent enough to be on the first page, and someone replied. */
async function recentPostsWithReplies(account: ThreadsAccount): Promise<string[]> {
  const result = await metaGet("/me/threads", account.access_token!, {
    fields: "id,has_replies",
    limit: MAX_POSTS_PER_ACCOUNT,
  });
  if (!result.ok || result.data?.error) {
    console.warn(`[threads-poll] ${account.platform_username}: listing posts failed`);
    return [];
  }
  return (Array.isArray(result.data?.data) ? result.data.data : [])
    .filter((post: any) => post?.has_replies === true)
    .map((post: any) => String(post.id));
}

async function pollAccount(admin: any, account: ThreadsAccount): Promise<number> {
  // An account whose inbox has never been written to is being polled for the first time, so
  // its whole visible history would look brand new. Record that history without firing it.
  const { count } = await admin
    .from("social_inbox_events")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", account.id);
  const dispatch = (count ?? 0) > 0;
  if (!dispatch) {
    console.log(`[threads-poll] ${account.platform_username}: first pass, recording history without dispatching`);
  }

  let dispatched = 0;
  for (const postId of await recentPostsWithReplies(account)) {
    const result = await metaGet(`/${encodeURIComponent(postId)}/conversation`, account.access_token!, {
      fields: STANDARD_REPLY_FIELDS,
    });
    if (!result.ok || result.data?.error) {
      console.warn(`[threads-poll] ${account.platform_username}: conversation ${postId} failed`);
      continue;
    }

    for (const reply of (Array.isArray(result.data?.data) ? result.data.data : [])) {
      // Graph answers this authoritatively, so it runs before the handle comparison inside
      // the ingest door rather than instead of it — that one still guards the webhook path,
      // where no such field is delivered.
      if (reply?.is_reply_owned_by_me === true) continue;
      const normalized = normalizeThreadsReply(
        { ...reply, root_post: reply?.root_post ?? { id: postId } },
        account.platform_username,
      );
      if (!normalized) continue;

      const outcome = await ingestThreadsComment(admin, account, normalized, { rawPayload: reply, dispatch });
      if (outcome === "dispatched_n8n" || outcome === "automated_internally") dispatched += 1;
    }
  }
  dispatched += await pollMentions(admin, account, dispatch);
  return dispatched;
}

// Mentions on other people's posts never appear in the account's own conversations, so they
// need their own read. The same ingest door dedupes a mention that was also seen as a reply
// under the account's own post — one comment, one fire, whichever read got there first.
async function pollMentions(admin: any, account: ThreadsAccount, dispatch: boolean): Promise<number> {
  const result = await metaGet("/me/mentions", account.access_token!, {
    fields: "id,text,timestamp,permalink,username,user{id,username},root_post,replied_to",
    limit: 25,
  });
  if (!result.ok || result.data?.error) {
    console.warn(`[threads-poll] ${account.platform_username}: listing mentions failed`);
    return 0;
  }
  let dispatched = 0;
  for (const mention of (Array.isArray(result.data?.data) ? result.data.data : [])) {
    if (!mention?.id) continue;
    const outcome = await ingestThreadsComment(admin, account, {
      comment: {
        id: String(mention.id),
        kind: "mention",
        text: String(mention.text || ""),
        parentCommentId: mention.replied_to?.id ? String(mention.replied_to.id) : null,
        mediaUrl: mention.permalink || null,
      },
      post: { id: mention.root_post?.id ? String(mention.root_post.id) : null, url: null, caption: null },
      author: { id: mention.user?.id ? String(mention.user.id) : null, name: null, username: mention.username || mention.user?.username || null },
      timestamp: mention.timestamp || undefined,
    }, { rawPayload: mention, dispatch });
    if (outcome === "dispatched_n8n" || outcome === "automated_internally") dispatched += 1;
  }
  return dispatched;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  // The cron job already sends `Authorization: Bearer <get_cron_secret()>`, but nothing
  // was checking it. Without this an anonymous caller could drive the whole sweep:
  // burning Meta Graph quota against every connected Threads account and firing the
  // n8n workflows and AI agent that each new comment dispatches. Checked before the
  // service-role client is created, so an unauthenticated request never reaches the
  // database at all. Same guard every other cron-invoked function here uses.
  const cronAuth = verifyCronAuth(req);
  if (!cronAuth.ok) return cronAuth.response;

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
  const { data: accounts, error } = await admin
    .from("social_accounts")
    .select(ACCOUNT_SELECT)
    .eq("platform", "threads")
    .eq("is_active", true);

  if (error) {
    console.error(`[threads-poll] could not list accounts: ${error.message}`);
    return new Response(JSON.stringify({ error: "account_listing_failed" }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }

  // Polling an account whose comments automate nowhere would spend Graph quota to reach a
  // handler that discards the result. The filter is in code rather than in the query because
  // "off" is also what an account with no automation key at all resolves to.
  const automated = (accounts || []).filter((account: ThreadsAccount) =>
    account.access_token && resolveCommentAutomationHandler(account.account_metadata) !== "off"
  );

  let dispatched = 0;
  for (const account of automated) {
    try {
      dispatched += await pollAccount(admin, account);
    } catch (err) {
      // One account's expired token must not stop the rest of the sweep.
      console.error(`[threads-poll] ${account.platform_username} failed: ${(err as Error).message}`);
    }
  }

  console.log(`[threads-poll] polled ${automated.length} account(s), dispatched ${dispatched} comment(s)`);
  return new Response(JSON.stringify({ success: true, polled: automated.length, dispatched }), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
});
