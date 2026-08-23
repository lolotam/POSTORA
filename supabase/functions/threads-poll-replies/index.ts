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
import { resolveCommentAutomationHandler } from "../_shared/automationHandler.ts";
import { ingestThreadsComment } from "../_shared/threadsCommentIngest.ts";
import { metaGet, STANDARD_REPLY_FIELDS } from "../_shared/threads-reply-helpers.ts";
import { normalizeThreadsReply } from "../threads-webhook/replyEvents.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

// One Graph call per post per run, so the post window is the cost knob. Two days covers any
// realistic reply-to-a-recent-post window while keeping a busy account inside single digits
// of calls per run; `has_replies` then removes the posts nobody answered.
const LOOKBACK_MS = 2 * 24 * 60 * 60 * 1000;
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

/** Recent posts worth asking about: within the window, and someone actually replied. */
async function recentPostsWithReplies(account: ThreadsAccount): Promise<string[]> {
  const result = await metaGet("/me/threads", account.access_token!, {
    fields: "id,timestamp,has_replies",
    limit: MAX_POSTS_PER_ACCOUNT,
  });
  if (!result.ok || result.data?.error) {
    console.warn(`[threads-poll] ${account.platform_username}: listing posts failed`);
    return [];
  }
  const cutoff = Date.now() - LOOKBACK_MS;
  return (Array.isArray(result.data?.data) ? result.data.data : [])
    .filter((post: any) => {
      if (post?.has_replies !== true) return false;
      const posted = post?.timestamp ? Date.parse(post.timestamp) : NaN;
      return Number.isNaN(posted) || posted >= cutoff;
    })
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
      const normalized = normalizeThreadsReply({ ...reply, root_post: reply?.root_post ?? { id: postId } });
      if (!normalized) continue;

      const outcome = await ingestThreadsComment(admin, account, normalized, { rawPayload: reply, dispatch });
      if (outcome === "dispatched_n8n" || outcome === "automated_internally") dispatched += 1;
    }
  }
  return dispatched;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

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
