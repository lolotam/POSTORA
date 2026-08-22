// Internal (Postora-owned) handling of a public comment: deterministic auto-reply rules
// first, the AI agent for whatever the rules did not claim. This is the "internal" branch of
// social_accounts.account_metadata.comment_automation_handler; "n8n" and "off" never reach
// here. Shared by facebook-instagram-webhook and threads-webhook so the two surfaces cannot
// drift apart.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { matchAutoReplyRule, type AutoReplyRule } from "./autoReplyRules.ts";
import { replyToComment } from "./commentActions.ts";
import { buildCommentConversationId, postConversationLikePrefix } from "./commentConversation.ts";

export interface CommentAutomationAccount {
  id: string;
  user_id: string;
  platform: string;
  access_token: string | null;
  platform_user_id?: string | null;
  platform_username?: string | null;
  ig_auth_type?: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface CommentAutomationInput {
  comment: { id: string; text: string };
  post: { id: string | null };
  author: { id: string | null; username: string | null };
}

export type CommentAutomationOutcome =
  | "rule_replied"
  | "rule_suppressed"
  | "agent_dispatched"
  | "skipped";

export interface CommentAutomationDeps {
  fetcher?: typeof fetch;
  now?: Date;
}

// Unordered on purpose: matchAutoReplyRule owns precedence, so ordering it here too would
// state the same rule in two places and let them drift.
async function loadActiveRules(admin: any, account: CommentAutomationAccount): Promise<AutoReplyRule[]> {
  const { data, error } = await admin
    .from("messenger_auto_replies")
    .select("*")
    .eq("user_id", account.user_id)
    .eq("platform", account.platform)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data || []) as AutoReplyRule[];
}

// An away message is written for a private inbox ("we're closed, we'll get back to you
// tomorrow"). Posted under every comment on a busy post it reads as spam, so on the public
// surface it goes out at most once per post per day. Keyword rules are the natural public
// case ("price" -> "DM us for a quote") and stay per commenter.
async function awayAlreadyPostedOnThisPost(
  admin: any,
  { account, ruleId, postId, now }: {
    account: CommentAutomationAccount;
    ruleId: string;
    postId: string;
    now: Date;
  },
): Promise<boolean> {
  const midnightUtc = new Date(now);
  midnightUtc.setUTCHours(0, 0, 0, 0);
  const { count } = await admin
    .from("messenger_auto_reply_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", account.user_id)
    .eq("auto_reply_rule_id", ruleId)
    .like("conversation_id", postConversationLikePrefix(account.id, postId))
    .gte("triggered_at", midnightUtc.toISOString());
  return (count || 0) > 0;
}

async function dispatchToAiAgent(
  account: CommentAutomationAccount,
  input: CommentAutomationInput,
  conversationId: string,
  fetcher: typeof fetch,
): Promise<void> {
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const response = await fetcher(`${supabaseUrl}/functions/v1/ai-agent-reply`, {
    method: "POST",
    headers: { Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      user_id: account.user_id,
      platform: account.platform,
      social_account_id: account.id,
      conversation_id: conversationId,
      // Unused by the comment sender, but the request contract requires it and it keeps the
      // log rows readable.
      recipient_phone: input.author.id || input.author.username || input.comment.id,
      inbound_text: input.comment.text,
      comment_id: input.comment.id,
    }),
  });
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    console.error(`[comment-automation] ai-agent-reply returned ${response.status}: ${body.slice(0, 200)}`);
  }
}

// Callers must have already established that this comment is not the account's own (see
// isOwnComment) -- that check is what stops the agent answering its own replies forever.
export async function handleCommentInternally(
  admin: any,
  account: CommentAutomationAccount,
  input: CommentAutomationInput,
  deps: CommentAutomationDeps = {},
): Promise<CommentAutomationOutcome> {
  const fetcher = deps.fetcher ?? fetch;
  const now = deps.now ?? new Date();
  // Threads mentions arrive without a root post and Threads replies without an author id, so
  // both fall back to the comment's own id rather than collapsing every such event into one
  // shared thread.
  const postId = input.post.id || input.comment.id;
  const authorKey = input.author.id || input.author.username || input.comment.id;
  const conversationId = buildCommentConversationId(account.id, postId, authorKey);

  let match: ReturnType<typeof matchAutoReplyRule>;
  try {
    match = matchAutoReplyRule(await loadActiveRules(admin, account), input.comment.text, now);
  } catch (error) {
    // The DM path lets the agent answer when rule evaluation fails. Publicly, replying while
    // the rule configuration is in an unknown state is the worse outcome, so this fails closed.
    console.error("[comment-automation] rule lookup failed, not replying:", (error as Error).message);
    return "skipped";
  }

  if (!match) {
    await dispatchToAiAgent(account, input, conversationId, fetcher);
    return "agent_dispatched";
  }

  if (
    match.ruleType === "away" &&
    await awayAlreadyPostedOnThisPost(admin, { account, ruleId: match.ruleId, postId, now })
  ) {
    return "rule_suppressed";
  }

  const result = await replyToComment(account, input.comment.id, match.replyMessage, fetcher);
  if (!result.success) {
    console.error(`[comment-automation] rule reply failed: ${result.error}`);
  }

  // Written even when the send failed: the row is what the once-per-post away guard reads,
  // and a platform that rejected one reply will reject the next one on the same post too.
  const { error: usageError } = await admin.from("messenger_auto_reply_usage").insert({
    user_id: account.user_id,
    auto_reply_rule_id: match.ruleId,
    conversation_id: conversationId,
  });
  if (usageError) console.warn("[comment-automation] usage log failed:", usageError.message);

  // A matched rule claims the comment whether or not the send succeeded, so a failing rule
  // never falls through to the AI -- same precedence the DM path uses.
  return "rule_replied";
}
