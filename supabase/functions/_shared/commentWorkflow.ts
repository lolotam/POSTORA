// Comment Workflow: deterministic comment-to-DM funnels ("comment GUIDE and we DM you the
// link"). This runs AHEAD of the comment_automation_handler switch in both ingestion paths,
// for every handler value including the default "off", and a claim means no other automation
// touches the comment — not the internal keyword rules, not the AI agent, not the n8n
// dispatch. Creating a rule is itself the per-account opt-in; comment_automation_handler is
// the account-wide fallback for everything a funnel did not claim.
//
// Spec: docs/superpowers/specs/2026-09-03-comment-workflow-funnels.md
/* eslint-disable @typescript-eslint/no-explicit-any */
import { matchCommentWorkflowRule, type CommentWorkflowRule } from "./commentWorkflowRules.ts";
import { replyToComment } from "./commentActions.ts";
import { sendPrivateReply, type PrivateReplyAccount } from "./metaPrivateReply.ts";
import { ownedStoragePath, signMediaPath } from "./whatsappMediaResolver.ts";
import type { CommentAutomationAccount } from "./commentAutomation.ts";

export interface CommentWorkflowInput {
  // `kind` decides whether this is a funnel-eligible comment at all: Threads routes mentions
  // through the same ingest door, and a mention is somebody naming the account somewhere else
  // entirely, not a comment under a post the account owns.
  comment: { id: string; text: string; kind?: string };
  post: { id: string | null };
  author: { id: string | null; username: string | null };
  /** When the comment was written. Absent on sources that do not carry one. */
  timestamp?: string;
}

export interface CommentWorkflowDeps {
  fetcher?: typeof fetch;
  now?: Date;
  /** Which of the rotated public replies to use. Injectable so tests are not random. */
  pick?: (replies: string[]) => string;
}

export type CommentWorkflowOutcome = "claimed" | "unclaimed";

// Meta accepts a private reply only within 7 days of the comment. Checking locally turns a
// guaranteed rejection on a delayed redelivery into a clean `skipped` with a reason.
const PRIVATE_REPLY_WINDOW_MS = 7 * 24 * 3600 * 1000;
// A private reply is one-shot: there is no later message in which to refresh an expired link,
// so the link outlives the window in which the person is likely to open it.
const MEDIA_LINK_TTL_SECONDS = 7 * 24 * 3600;
const UNIQUE_VIOLATION = "23505";

type SendStatus = "pending" | "sent" | "failed" | "skipped" | "indeterminate" | "not_applicable";

function uniformPick(replies: string[]): string {
  return replies[Math.floor(Math.random() * replies.length)];
}

// Structured, and never carrying comment text, reply copy or a token. Every refusal below logs
// one of these: a funnel that silently declines to fire is the failure this feature is most
// likely to hit, and it is invisible without a row to find.
function log(event: string, fields: Record<string, unknown>): void {
  console.log(JSON.stringify({ event: `comment_workflow.${event}`, ...fields }));
}

async function loadActiveRules(admin: any, account: CommentAutomationAccount): Promise<CommentWorkflowRule[]> {
  const { data, error } = await admin
    .from("comment_workflow_rules")
    .select("*")
    .eq("social_account_id", account.id)
    .eq("is_active", true);
  if (error) throw new Error(error.message);
  return (data || []) as CommentWorkflowRule[];
}

/**
 * Writes the event row, which is both the audit trail and this feature's own idempotency key.
 *
 * Returns null when the row already existed — another invocation owns this comment and will
 * answer it. The upstream `social_inbox_events` claim already stops platform redeliveries;
 * this exists because the poller and the webhook can both reach a Threads comment, and because
 * a row written before any send is what turns a killed worker into a visible `pending` row
 * instead of silence. Nothing sweeps those rows up — they are a signal to a human, not a queue.
 */
async function recordEvent(
  admin: any,
  account: CommentAutomationAccount,
  rule: CommentWorkflowRule,
  input: CommentWorkflowInput,
  authorKey: string,
  dmStatus: SendStatus,
): Promise<string | null> {
  const { data, error } = await admin
    .from("comment_workflow_events")
    .upsert({
      rule_id: rule.id,
      user_id: account.user_id,
      social_account_id: account.id,
      platform: account.platform,
      external_post_id: input.post.id,
      external_comment_id: input.comment.id,
      author_key: authorKey,
      author_username: input.author.username,
      comment_text: input.comment.text,
      public_reply_status: "pending",
      dm_status: dmStatus,
    }, { onConflict: "social_account_id,external_comment_id", ignoreDuplicates: true })
    .select("id");
  if (error) throw new Error(error.message);
  return data?.length ? String(data[0].id) : null;
}

async function finalizeEvent(
  admin: any,
  eventId: string,
  patch: {
    public_reply_status: SendStatus;
    dm_status: SendStatus;
    public_reply_id?: string | null;
    error_message?: string | null;
  },
): Promise<void> {
  const { error } = await admin.from("comment_workflow_events").update(patch).eq("id", eventId);
  if (error) {
    // The sends already happened; losing the status write leaves a `pending` row that
    // misreports a delivery that did occur. Worth a log line, not worth failing over.
    console.error("[comment-workflow] event finalize failed:", error.message);
    log("event_finalize_failed", { event_id: eventId });
  }
}

/**
 * Takes the send-once claim BEFORE the send. A read-then-check loses the race between two
 * comments from the same person landing in different edge isolates; a primary key does not.
 * Same shape as the "cancel the outbox row first" ordering in commentAutomation.ts.
 */
async function claimUsage(
  admin: any,
  rule: CommentWorkflowRule,
  authorKey: string,
  postKey: string,
): Promise<"claimed" | "already_served"> {
  const { error } = await admin
    .from("comment_workflow_usage")
    .insert({ rule_id: rule.id, author_key: authorKey, external_post_id: postKey });
  if (!error) return "claimed";
  if (error.code === UNIQUE_VIOLATION) return "already_served";
  throw new Error(error.message);
}

/**
 * Released only when NOTHING was delivered, so the person's next comment can be served.
 *
 * The lossy case is deliberate and bounded: if a second comment from the same person was
 * skipped while the first was still failing, that second comment is not retried — the release
 * only reopens the claim for a future one. The alternative, holding a claim after a total
 * failure, silently drops the lead for good.
 */
async function releaseUsage(
  admin: any,
  rule: CommentWorkflowRule,
  authorKey: string,
  postKey: string,
): Promise<void> {
  const { error } = await admin
    .from("comment_workflow_usage")
    .delete()
    .eq("rule_id", rule.id)
    .eq("author_key", authorKey)
    .eq("external_post_id", postKey);
  if (error) {
    console.warn("[comment-workflow] usage release failed:", error.message);
    log("usage_release_failed", { rule_id: rule.id });
  }
}

/**
 * The DM text plus, when the rule carries a file, a signed link to it.
 *
 * The media row is read by (id, user_id) so a rule can only ever reach its own owner's files,
 * and the bucket is re-checked here rather than trusted from rule creation time — a file can
 * move between the two. A signing failure loses the link, not the message: a lead who gets the
 * copy and no link can still be answered by hand, a lead who gets nothing cannot.
 */
async function composeDm(
  admin: any,
  rule: CommentWorkflowRule,
  account: CommentAutomationAccount,
): Promise<{ text: string; mediaError: string | null }> {
  const text = rule.dm_message || "";
  if (!rule.media_file_id) return { text, mediaError: null };

  const { data: media, error } = await admin
    .from("media_files")
    .select("file_path, storage_bucket")
    .eq("id", rule.media_file_id)
    .eq("user_id", account.user_id)
    .maybeSingle();
  // A discarded error beside maybeSingle() is how a statement timeout reads as "no such file".
  if (error) {
    console.error("[comment-workflow] media lookup failed:", error.message);
    log("media_lookup_failed", { rule_id: rule.id, account_id: account.id });
    return { text, mediaError: "media_lookup_failed" };
  }
  if (!media?.file_path) {
    log("media_missing", { rule_id: rule.id, account_id: account.id });
    return { text, mediaError: "media_missing" };
  }
  // Re-read at SEND time rather than trusting what the form filtered on: a file can move
  // buckets after a rule is saved, and signMediaPath always signs `media` regardless.
  if (media.storage_bucket && media.storage_bucket !== "media") {
    log("media_wrong_bucket", { rule_id: rule.id, account_id: account.id, bucket: media.storage_bucket });
    return { text, mediaError: "media_wrong_bucket" };
  }

  // media_files' insert policy only checks that the ROW's user_id is the caller's — file_path
  // is unconstrained. Without this, a user could save a row naming somebody else's object path
  // and have the service role sign that object into a DM. ownedStoragePath requires the first
  // path segment to be the owner's uid, and rejects traversal and absolute URLs.
  let ownedPath: string;
  try {
    ownedPath = ownedStoragePath(media.file_path, account.user_id);
  } catch {
    log("media_path_not_owned", { rule_id: rule.id, account_id: account.id });
    return { text, mediaError: "media_path_not_owned" };
  }

  const url = await signMediaPath(admin, ownedPath, MEDIA_LINK_TTL_SECONDS);
  if (!url) {
    log("media_sign_failed", { rule_id: rule.id, account_id: account.id });
    return { text, mediaError: "media_sign_failed" };
  }
  return { text: text ? `${text}\n\n${url}` : url, mediaError: null };
}

function withinPrivateReplyWindow(input: CommentWorkflowInput, now: Date): boolean {
  if (!input.timestamp) return true;
  const writtenAt = new Date(input.timestamp).getTime();
  // An unparseable timestamp is not evidence the window closed; let Meta decide.
  if (Number.isNaN(writtenAt)) return true;
  return now.getTime() - writtenAt <= PRIVATE_REPLY_WINDOW_MS;
}

/** What one funnel run needs to know about the rule and the comment, resolved once. */
interface WorkflowTarget {
  rule: CommentWorkflowRule;
  authorKey: string;
  postKey: string;
  wantsDm: boolean;
  wantsPublicReply: boolean;
}

function resolveTarget(
  rule: CommentWorkflowRule,
  account: CommentAutomationAccount,
  input: CommentWorkflowInput,
): WorkflowTarget {
  return {
    rule,
    // Threads mentions arrive without a root post and Threads replies without an author id, so
    // both fall back to the comment's own id — the same fallback handleCommentInternally uses,
    // and the reason external_post_id can be ''.
    authorKey: input.author.id || input.author.username || input.comment.id,
    postKey: input.post.id || "",
    // The account's platform decides this, never the presence of the column: a Threads rule can
    // only carry DM copy through a bug, and it must still send nothing.
    wantsDm: account.platform !== "threads" && !!rule.dm_message,
    wantsPublicReply: (rule.public_replies || []).length > 0,
  };
}

interface SendReport {
  publicStatus: SendStatus;
  publicReplyId: string | null;
  dmStatus: SendStatus;
  errors: string[];
}

/**
 * A timeout is not a non-delivery. callGraph flags an unreachable upstream separately precisely
 * because Meta may have accepted the request before the response was lost, and calling that
 * `failed` would free the send-once claim for a message that may already have arrived.
 */
function statusOf(result: { success: boolean; upstreamUnavailable?: boolean }): SendStatus {
  if (result.success) return "sent";
  return result.upstreamUnavailable ? "indeterminate" : "failed";
}

/**
 * Both legs of one funnel hit. They are independent — neither failure cancels the other — and
 * each is attempted exactly once. Meta allows one private reply per comment, so a retry can
 * only be refused, and that refusal is indistinguishable from the original failure.
 */
async function performSends(
  admin: any,
  account: CommentAutomationAccount,
  target: WorkflowTarget,
  input: CommentWorkflowInput,
  runtime: { fetcher: typeof fetch; now: Date; pick: (replies: string[]) => string },
): Promise<SendReport> {
  const report: SendReport = {
    publicStatus: target.wantsPublicReply ? "pending" : "skipped",
    publicReplyId: null,
    dmStatus: target.wantsDm ? "pending" : "not_applicable",
    errors: [],
  };

  // Public reply first: it is the visible half, and the DM's own copy usually points at it
  // ("check your DM").
  if (target.wantsPublicReply) {
    const replies = target.rule.public_replies as string[];
    const result = await replyToComment(account, input.comment.id, runtime.pick(replies), runtime.fetcher);
    report.publicStatus = statusOf(result);
    report.publicReplyId = result.platform_comment_id ?? null;
    if (!result.success && result.error) report.errors.push(result.error);
  }

  if (!target.wantsDm) return report;

  if (!withinPrivateReplyWindow(input, runtime.now)) {
    report.dmStatus = "skipped";
    report.errors.push("private_reply_window_elapsed");
    log("private_reply_window_elapsed", {
      account_id: account.id,
      rule_id: target.rule.id,
      comment_id: input.comment.id,
    });
    return report;
  }

  const { text, mediaError } = await composeDm(admin, target.rule, account);
  if (mediaError) report.errors.push(mediaError);
  const result = await sendPrivateReply(
    admin,
    account as PrivateReplyAccount,
    input.comment.id,
    text,
    runtime.fetcher,
  );
  report.dmStatus = statusOf(result);
  if (!result.success && result.error) report.errors.push(result.error);
  return report;
}

/**
 * The send-once claim, and what to record when it cannot be taken.
 *
 * "stop" means the comment is settled and nothing should be sent: either this person was
 * already served on this post, or the claim table itself failed and sending without a claim
 * could message them twice. Either way the funnel still owns the comment.
 */
async function takeSendOnceClaim(
  admin: any,
  target: WorkflowTarget,
  eventId: string,
  trace: Record<string, unknown>,
): Promise<"held" | "not_needed" | "stop"> {
  if (!target.rule.send_once_per_user) return "not_needed";

  try {
    if (await claimUsage(admin, target.rule, target.authorKey, target.postKey) === "already_served") {
      await finalizeEvent(admin, eventId, {
        public_reply_status: "skipped",
        dm_status: target.wantsDm ? "skipped" : "not_applicable",
        error_message: "already_served",
      });
      log("already_served", trace);
      return "stop";
    }
    return "held";
  } catch (error) {
    console.error("[comment-workflow] usage claim failed:", (error as Error).message);
    log("usage_claim_failed", trace);
    await finalizeEvent(admin, eventId, {
      public_reply_status: "failed",
      dm_status: target.wantsDm ? "failed" : "not_applicable",
      error_message: "usage_claim_failed",
    });
    return "stop";
  }
}

/**
 * Runs the account's funnel rules against one public comment.
 *
 * Callers must have already established that the comment is not the account's own (isOwnComment
 * upstream) — that check is what stops a public reply coming back as another comment forever.
 */
export async function runCommentWorkflow(
  admin: any,
  account: CommentAutomationAccount,
  input: CommentWorkflowInput,
  deps: CommentWorkflowDeps = {},
): Promise<CommentWorkflowOutcome> {
  const runtime = {
    fetcher: deps.fetcher ?? fetch,
    now: deps.now ?? new Date(),
    pick: deps.pick ?? uniformPick,
  };

  // Threads routes mentions through the same ingest door as replies (threads-webhook,
  // threads-mentions), and a mention carries no post of the account's own. A funnel is written
  // for "comment GUIDE under my post"; firing it because a stranger typed the account's handle
  // in their own thread would DM someone who never engaged with the post at all.
  if (input.comment.kind === "mention") return "unclaimed";

  let rules: CommentWorkflowRule[];
  try {
    rules = await loadActiveRules(admin, account);
  } catch (error) {
    // A failed read must never read as "this account has no funnels". Fall through to the
    // normal pipeline rather than swallowing the comment.
    console.error("[comment-workflow] rule lookup failed:", (error as Error).message);
    log("rules_unavailable", { account_id: account.id, platform: account.platform, comment_id: input.comment.id });
    return "unclaimed";
  }

  const rule = matchCommentWorkflowRule(rules, input.comment.text, input.post.id);
  if (!rule) return "unclaimed";

  const target = resolveTarget(rule, account, input);
  const trace = { account_id: account.id, rule_id: rule.id, comment_id: input.comment.id };
  const idleDmStatus: SendStatus = target.wantsDm ? "pending" : "not_applicable";

  let eventId: string | null;
  try {
    eventId = await recordEvent(admin, account, rule, input, target.authorKey, idleDmStatus);
  } catch (error) {
    // The rule matched, so this comment belongs to the funnel. Returning "unclaimed" here would
    // hand it to the AI agent, which would answer a comment the user wrote a fixed reply for.
    // Refusing to act is the smaller wrong.
    console.error("[comment-workflow] event insert failed:", (error as Error).message);
    log("event_write_failed", trace);
    return "claimed";
  }
  if (!eventId) {
    log("already_claimed", trace);
    return "claimed";
  }

  const claim = await takeSendOnceClaim(admin, target, eventId, trace);
  if (claim === "stop") return "claimed";

  const report = await performSends(admin, account, target, input, runtime);

  // The claim is released ONLY when every attempt is known not to have been delivered. An
  // `indeterminate` leg keeps it: freeing the claim would let this person's next comment
  // produce a second DM for something they may already have received. The existing DM
  // automation makes the same choice — commentAutomation.ts records usage in a `finally`, so a
  // failed send still throttles.
  const delivered = report.publicStatus === "sent" || report.dmStatus === "sent";
  const unknown = report.publicStatus === "indeterminate" || report.dmStatus === "indeterminate";
  if (claim === "held" && !delivered && !unknown) {
    await releaseUsage(admin, rule, target.authorKey, target.postKey);
  }

  await finalizeEvent(admin, eventId, {
    public_reply_status: report.publicStatus,
    dm_status: report.dmStatus,
    public_reply_id: report.publicReplyId,
    error_message: report.errors.length > 0 ? report.errors.join("; ") : null,
  });

  log("handled", {
    ...trace,
    platform: account.platform,
    public_reply_status: report.publicStatus,
    dm_status: report.dmStatus,
  });
  return "claimed";
}
