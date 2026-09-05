// Which automation, if any, answers one inbound Facebook/Instagram comment.
//
// Extracted from index.ts so the precedence below can be tested against a fake client instead
// of a live Deno.serve: index.ts registers its server at module load, so nothing importable
// there can be exercised by a test. The rule this file exists to protect is a single sentence,
// and it is the one that breaks loudest if it drifts — exactly one automation may answer a
// comment.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { type CommentAutomationHandler } from "../_shared/automationHandler.ts";
import { handleCommentInternally } from "../_shared/commentAutomation.ts";
import { runCommentWorkflow } from "../_shared/commentWorkflow.ts";
import { buildCommentPayload, dispatchN8nEvent } from "../_shared/n8nMessagingDispatch.ts";
import type { MetaCommentInput } from "./commentEvents.ts";

export type CommentRoute = "workflow" | "n8n" | "internal" | "none";

export interface CommentRoutingDeps {
  runWorkflow?: typeof runCommentWorkflow;
  dispatchN8n?: typeof dispatchN8nEvent;
  handleInternally?: typeof handleCommentInternally;
}

/**
 * Runs Comment Workflow funnels, then the account's comment_automation_handler.
 *
 * Funnels come first and fire for EVERY handler value, including the default "off": creating a
 * rule is itself the per-account opt-in, while comment_automation_handler is the account-wide
 * fallback for everything a funnel did not claim.
 *
 * A claim ends routing. Letting a claimed comment continue to n8n would put a funnel's public
 * reply and a subscriber's auto-reply under the same comment, and letting it continue to the
 * internal handler would have the AI agent answer a comment the user wrote a fixed reply for.
 *
 * The caller must have consumed its social_inbox_events claim and its own-comment check first;
 * neither is repeated here.
 */
export async function routeComment(
  admin: any,
  account: any,
  platform: "facebook" | "instagram",
  normalized: MetaCommentInput,
  handler: CommentAutomationHandler,
  deps: CommentRoutingDeps = {},
): Promise<CommentRoute> {
  const runWorkflow = deps.runWorkflow ?? runCommentWorkflow;
  const dispatchN8n = deps.dispatchN8n ?? dispatchN8nEvent;
  const handleInternally = deps.handleInternally ?? handleCommentInternally;

  const workflow = await runWorkflow(admin, account, {
    comment: normalized.comment,
    post: normalized.post,
    author: normalized.author,
    timestamp: normalized.timestamp,
  });
  if (workflow === "claimed") return "workflow";

  if (handler === "n8n") {
    await dispatchN8n(
      admin,
      account.user_id,
      buildCommentPayload({ platform, socialAccountId: account.id, account, ...normalized }),
    );
    return "n8n";
  }

  if (handler === "internal") {
    await handleInternally(admin, account, {
      comment: normalized.comment,
      post: normalized.post,
      author: normalized.author,
    });
    return "internal";
  }

  return "none";
}
