// Internal (Postora-owned) handling of a public comment: deterministic auto-reply rules
// first, the AI agent for whatever the rules did not claim. This is the "internal" branch of
// social_accounts.account_metadata.comment_automation_handler; "n8n" and "off" never reach
// here. Shared by facebook-instagram-webhook and threads-webhook so the two surfaces cannot
// drift apart.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { matchAutoReplyRule, type AutoReplyMatch, type AutoReplyRule } from "./autoReplyRules.ts";
import { replyToComment } from "./commentActions.ts";
import { buildCommentConversationId, postConversationLikePrefix } from "./commentConversation.ts";
import { enqueueAgentReply } from "./pendingReplies.ts";
import { dispatchAgentReply } from "./agentReplyDispatch.ts";
import { cancelOutboxRow } from "../ai-agent-reply/outbox.ts";

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

// The DM path throttles auto-replies with a module-level Map, which edge isolates recycle.
// The public surface uses the usage table instead, so a burst of comments landing across
// isolates is still throttled. The two rule kinds need different scopes:
//
//   away    -- once per post per day. An away message is written for a private inbox ("we're
//              closed, back tomorrow"); posted under every comment on a busy post it is spam.
//   keyword -- once per commenter per post per KEYWORD_COOLDOWN_MS. Answering each new
//              commenter is the point ("price" -> "DM us for a quote"), but repeating the
//              same canned line at one person firing off five comments is not.
const KEYWORD_COOLDOWN_MS = 5 * 60 * 1000;

async function ruleAlreadyReplied(
  admin: any,
  { account, match, conversationId, postId, now }: {
    account: CommentAutomationAccount;
    match: AutoReplyMatch;
    conversationId: string;
    postId: string;
    now: Date;
  },
): Promise<boolean> {
  const since = new Date(now);
  if (match.ruleType === "away") since.setUTCHours(0, 0, 0, 0);
  else since.setTime(since.getTime() - KEYWORD_COOLDOWN_MS);

  const scoped = admin
    .from("messenger_auto_reply_usage")
    .select("id", { count: "exact", head: true })
    .eq("user_id", account.user_id)
    .eq("auto_reply_rule_id", match.ruleId)
    .gte("triggered_at", since.toISOString());

  const { count } = await (match.ruleType === "away"
    ? scoped.like("conversation_id", postConversationLikePrefix(account.id, postId))
    : scoped.eq("conversation_id", conversationId));
  return (count || 0) > 0;
}

/**
 * Hands the comment to the agent. The work item was already recorded by the caller, ahead of
 * the rule lookup -- see the enqueue in handleCommentInternally for why that ordering is the
 * guarantee. The agent settles the row itself from here.
 */
async function dispatchToAiAgent(
  account: CommentAutomationAccount,
  input: CommentAutomationInput,
  context: { conversationId: string; fetcher: typeof fetch; authorKey: string; outboxId: string | null },
): Promise<void> {
  await dispatchAgentReply({
    userId: account.user_id,
    platform: account.platform,
    socialAccountId: account.id,
    conversationId: context.conversationId,
    recipientId: context.authorKey,
    inboundText: input.comment.text,
    commentId: input.comment.id,
    outboxId: context.outboxId,
  }, context.fetcher);
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

  // The outbox row is created FIRST, ahead of the rule lookup and any reply.
  //
  // Both callers -- the Facebook/Instagram webhook and the Threads ingest -- consume their
  // social_inbox_events claim before calling this, and that claim is what makes a platform
  // redelivery a no-op. So every await between the claim and this line is a window in which
  // a killed worker loses the comment for good: the platform will not tell us again, and no
  // row exists for recovery to find. It used to hold the rules query and, on a matched rule,
  // a network send.
  //
  // What remains uncovered is the claim itself plus the runInBackground hand-off, which is
  // scheduling rather than I/O. Closing that last gap needs the claim and the enqueue in one
  // transaction -- a shared RPC across three call sites, for a window measured in
  // instructions.
  const enqueued = await enqueueAgentReply(admin, {
    socialAccountId: account.id,
    platform: account.platform,
    messageId: input.comment.id,
    conversationId,
    // Unused by the comment sender, but the request contract requires it and it keeps the
    // log rows readable.
    recipientId: authorKey,
    inboundText: input.comment.text,
    inboundAt: now.toISOString(),
    // Set, and this is what makes a recovered reply a public comment rather than a DM to
    // the author.
    commentId: input.comment.id,
  });
  // Another invocation already owns this comment; it or recovery will answer.
  if (enqueued && !enqueued.newlyEnqueued) return "skipped";
  const outboxId = enqueued?.id ?? null;

  /** Nothing will be sent through the agent, so the row must not outlive this decision. */
  const abandon = async (outcome: CommentAutomationOutcome, reason: string) => {
    if (outboxId) await cancelOutboxRow(admin, outboxId, reason);
    return outcome;
  };

  let match: ReturnType<typeof matchAutoReplyRule>;
  try {
    match = matchAutoReplyRule(await loadActiveRules(admin, account), input.comment.text, now);
  } catch (error) {
    // The DM path lets the agent answer when rule evaluation fails. Publicly, replying while
    // the rule configuration is in an unknown state is the worse outcome, so this fails closed.
    console.error("[comment-automation] rule lookup failed, not replying:", (error as Error).message);
    return await abandon("skipped", "rule_lookup_failed");
  }

  if (!match) {
    await dispatchToAiAgent(account, input, { conversationId, fetcher, authorKey, outboxId });
    return "agent_dispatched";
  }

  if (await ruleAlreadyReplied(admin, { account, match, conversationId, postId, now })) {
    return await abandon("rule_suppressed", "rule_suppressed");
  }

  // Recorded in `finally`, before any send failure can propagate. The usage row is the
  // throttle -- if a network error skipped it, the next comment would retry a send that is
  // already known to be failing, and an away rule would post again on the same post.
  try {
    const result = await replyToComment(account, input.comment.id, match.replyMessage, fetcher);
    if (!result.success) console.error(`[comment-automation] rule reply failed: ${result.error}`);
  } finally {
    const { error: usageError } = await admin.from("messenger_auto_reply_usage").insert({
      user_id: account.user_id,
      auto_reply_rule_id: match.ruleId,
      conversation_id: conversationId,
    });
    if (usageError) console.warn("[comment-automation] usage log failed:", usageError.message);
  }

  // A matched rule claims the comment whether or not the send succeeded, so a failing rule
  // never falls through to the AI -- same precedence the DM path uses.
  return "rule_replied";
}
