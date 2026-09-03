// The single door every polled comment goes through. The inbox insert is the cross-source
// idempotency claim; first-pass seeding and own-comment suppression apply to every provider.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { resolveCommentAutomationHandler } from "./automationHandler.ts";
import { runInBackground } from "./background.ts";
import { isOwnComment } from "./commentAuthor.ts";
import {
  type CommentAutomationAccount,
  handleCommentInternally,
} from "./commentAutomation.ts";
import { runCommentWorkflow } from "./commentWorkflow.ts";
import {
  buildCommentPayload,
  type CommentPayloadInput,
  type CommentPlatform,
  dispatchN8nEvent,
} from "./n8nMessagingDispatch.ts";

export type PolledCommentOutcome =
  | "persist_failed"
  | "duplicate"
  | "own_comment"
  | "seeded"
  | "dispatched_n8n"
  | "automated_internally"
  | "no_handler";

export type PolledCommentInput = Omit<
  CommentPayloadInput,
  "platform" | "socialAccountId" | "account"
>;

export interface PolledIngestOptions {
  // Stored verbatim so a delivery can be replayed from what arrived, not its normalized view.
  rawPayload: unknown;
  // False on a poller's first pass over an account. See the seeding note below.
  dispatch?: boolean;
}

/** The inbox insert is the idempotency claim. Only its first writer may run automation. */
export async function ingestPolledComment(
  admin: any,
  account: CommentAutomationAccount,
  platform: CommentPlatform,
  comment: PolledCommentInput,
  options: PolledIngestOptions,
): Promise<PolledCommentOutcome> {
  const { data: inserted, error } = await admin
    .from("social_inbox_events")
    .upsert({
      user_id: account.user_id,
      social_account_id: account.id,
      platform,
      event_type: "comment",
      external_event_id: comment.comment.id,
      payload: options.rawPayload,
    }, {
      onConflict: "social_account_id,external_event_id",
      ignoreDuplicates: true,
    })
    .select("id");

  if (error) {
    console.error(
      `[${platform}-ingest] inbox persist failed for ${comment.comment.id}: ${error.message}`,
    );
    return "persist_failed";
  }
  if (!inserted?.length) return "duplicate";

  // This stays ahead of every handler: a reply emitted below comes back as another comment,
  // and only this check ends that cycle.
  if (isOwnComment(account, comment.author)) {
    console.log(
      `[${platform}-ingest] skipped own comment ${comment.comment.id}`,
    );
    return "own_comment";
  }

  // A first pass sees history. Record it so the next pass can identify new comments, but do
  // not replay that history into a live workflow or AI agent.
  if (options.dispatch === false) return "seeded";

  const handler = resolveCommentAutomationHandler(account.account_metadata);

  await runInBackground(`${platform} comment routing`, async () => {
    const workflow = await runCommentWorkflow(admin, account, {
      comment: {
        id: comment.comment.id,
        text: comment.comment.text,
        kind: comment.comment.kind,
      },
      post: { id: comment.post.id },
      author: { id: comment.author.id, username: comment.author.username },
      timestamp: comment.timestamp,
    });
    if (workflow === "claimed") return;

    if (handler === "n8n") {
      await dispatchN8nEvent(
        admin,
        account.user_id,
        buildCommentPayload({
          platform,
          socialAccountId: account.id,
          account,
          ...comment,
        }),
      );
      return;
    }
    if (handler === "internal") {
      await handleCommentInternally(admin, account, {
        comment: { id: comment.comment.id, text: comment.comment.text },
        post: { id: comment.post.id },
        author: { id: comment.author.id, username: comment.author.username },
      });
    }
  });

  // Outcomes name the route that was started; durable workflow rows and logs hold completion.
  if (handler === "n8n") return "dispatched_n8n";
  if (handler === "internal") return "automated_internally";
  return "no_handler";
}
