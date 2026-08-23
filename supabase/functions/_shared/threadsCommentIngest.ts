// The single door every inbound Threads comment goes through: the `replies` webhook, the
// reply poller, and the mentions refresh alike. Threads is the only platform with more than
// one source for the same comment, so the two invariants below have to hold across sources
// rather than within one handler — which is why they live here and not in the callers.
/* eslint-disable @typescript-eslint/no-explicit-any */
import { resolveCommentAutomationHandler } from "./automationHandler.ts";
import { runInBackground } from "./background.ts";
import { isOwnComment } from "./commentAuthor.ts";
import { handleCommentInternally, type CommentAutomationAccount } from "./commentAutomation.ts";
import { buildCommentPayload, type CommentPayloadInput, dispatchN8nEvent } from "./n8nMessagingDispatch.ts";

export type ThreadsCommentOutcome =
  | "persist_failed"
  | "duplicate"
  | "own_comment"
  | "seeded"
  | "dispatched_n8n"
  | "automated_internally"
  | "no_handler";

// Everything buildCommentPayload needs except the three fields this module already knows.
export type ThreadsCommentInput = Omit<CommentPayloadInput, "platform" | "socialAccountId" | "account">;

export interface ThreadsIngestOptions {
  // Stored verbatim on the inbox row so a delivery can be replayed from what actually arrived
  // rather than from the normalized shape.
  rawPayload: unknown;
  // False on a poller's first pass over an account. See the seeding note below.
  dispatch?: boolean;
}

/**
 * Records one Threads comment and runs whatever automation the account asked for.
 *
 * The `social_inbox_events` insert IS the idempotency claim, and that is the whole reason
 * this function exists: Meta retries webhook deliveries, and the poller re-reads the same
 * conversation every run, so the same reply arrives repeatedly and from two directions at
 * once. Only the first writer of a `(social_account_id, external_event_id)` pair may run the
 * user's workflow. A mention that is also a reply collapses to a single fire for the same
 * reason, which is deliberate — it is one event to the person who wrote it.
 */
export async function ingestThreadsComment(
  admin: any,
  account: CommentAutomationAccount,
  comment: ThreadsCommentInput,
  options: ThreadsIngestOptions,
): Promise<ThreadsCommentOutcome> {
  const { data: inserted, error } = await admin
    .from("social_inbox_events")
    .upsert({
      user_id: account.user_id,
      social_account_id: account.id,
      platform: "threads",
      event_type: "comment",
      external_event_id: comment.comment.id,
      payload: options.rawPayload,
    }, { onConflict: "social_account_id,external_event_id", ignoreDuplicates: true })
    .select("id");

  if (error) {
    console.error(`[threads-ingest] inbox persist failed for ${comment.comment.id}: ${error.message}`);
    return "persist_failed";
  }
  if (!inserted?.length) return "duplicate";

  // Has to stay ahead of both handler branches: whatever replies below comes back as another
  // reply on the same post, and only this check ends that cycle.
  if (isOwnComment(account, comment.author)) {
    console.log(`[threads-ingest] skipped own comment ${comment.comment.id}`);
    return "own_comment";
  }

  // A poller's first pass over an account sees a page of history all at once. Recording it is
  // what lets the next pass tell new from old; dispatching it would replay weeks of other
  // people's comments into a live workflow — or, on the `internal` handler, have the AI agent
  // answer all of them.
  if (options.dispatch === false) return "seeded";

  const handler = resolveCommentAutomationHandler(account.account_metadata);
  if (handler === "n8n") {
    await runInBackground("threads comment dispatch", () =>
      dispatchN8nEvent(
        admin,
        account.user_id,
        buildCommentPayload({ platform: "threads", socialAccountId: account.id, account, ...comment }),
      ));
    return "dispatched_n8n";
  }
  if (handler === "internal") {
    await runInBackground("threads comment automation", () =>
      handleCommentInternally(admin, account, {
        comment: { id: comment.comment.id, text: comment.comment.text },
        post: { id: comment.post.id },
        author: { id: comment.author.id, username: comment.author.username },
      }));
    return "automated_internally";
  }
  return "no_handler";
}
