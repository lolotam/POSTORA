/* eslint-disable @typescript-eslint/no-explicit-any */
import { ingestPolledComment } from "../_shared/polledCommentIngest.ts";
import { threadToInputs } from "../_shared/youtubeCommentNormalize.ts";
import {
  listThreads as listThreadsLive,
  type YouTubeCommentAccount,
  type YouTubeCommentsDeps,
} from "../_shared/youtubeComments.ts";
import { selectPollableChannels } from "../_shared/youtubePollEligibility.ts";

type PollAccount = YouTubeCommentAccount & { platform_user_id: string | null };

export const ACCOUNT_SELECT =
  "id, user_id, platform, platform_user_id, platform_username, auth_provider, access_token, refresh_token, token_expires_at, connection_id, workspace_id, account_metadata";

export interface PollDeps {
  youtube: YouTubeCommentsDeps;
  listThreads?: typeof listThreadsLive;
  ingest?: typeof ingestPolledComment;
}

export interface PollSummary {
  polled: number;
  dispatched: number;
  skipped: {
    handler_off: number;
    reconnect_required: number;
    duplicate_channel: number;
    quota: number;
    failed: number;
  };
}

async function pollChannel(
  admin: any,
  account: YouTubeCommentAccount,
  deps: PollDeps,
  summary: PollSummary,
): Promise<void> {
  const listThreads = deps.listThreads ?? listThreadsLive;
  const ingest = deps.ingest ?? ingestPolledComment;

  const { count, error } = await admin.from("social_inbox_events")
    .select("id", { count: "exact", head: true })
    .eq("social_account_id", account.id);
  if (error) throw new Error(`inbox_count_failed: ${error.message}`);
  const dispatch = (count ?? 0) > 0;

  const threads = await listThreads(account, deps.youtube, {
    channelId: account.platform_user_id!,
  });
  if (!threads.ok) {
    if (threads.kind === "quota") summary.skipped.quota += 1;
    else summary.skipped.failed += 1;
    console.warn(
      `[youtube-poll] ${account.id}: ${threads.kind}: ${threads.message}`,
    );
    return;
  }

  // Sweep limits: YouTube inlines at most five replies per thread, and order=time sorts by
  // top-level time. A new reply on a thread older than the newest 50 is fetched only when the
  // Comment Manager asks for that thread's full replies.
  for (const thread of threads.value.items) {
    for (const input of threadToInputs(thread)) {
      const outcome = await ingest(
        admin,
        account as any,
        "youtube",
        input,
        { rawPayload: thread, dispatch },
      );
      if (
        outcome === "dispatched_n8n" || outcome === "automated_internally"
      ) {
        summary.dispatched += 1;
      }
    }
  }
}

export async function pollYouTubeComments(
  admin: any,
  deps: PollDeps,
): Promise<PollSummary> {
  const { data, error } = await admin.from("social_accounts")
    .select(ACCOUNT_SELECT)
    .eq("platform", "youtube")
    .eq("is_active", true);
  if (error) throw new Error(`account_listing_failed: ${error.message}`);

  const selection = selectPollableChannels(
    (data ?? []) as PollAccount[],
  );
  const summary: PollSummary = {
    polled: selection.eligible.length,
    dispatched: 0,
    skipped: { ...selection.skipped, quota: 0, failed: 0 },
  };

  for (const account of selection.eligible) {
    try {
      await pollChannel(admin, account, deps, summary);
    } catch (error) {
      summary.skipped.failed += 1;
      const message = error instanceof Error
        ? error.message
        : "unknown failure";
      console.error(`[youtube-poll] ${account.id} failed: ${message}`);
    }
  }

  console.log(
    `[youtube-poll] polled ${summary.polled}, dispatched ${summary.dispatched}, skipped ${
      JSON.stringify(summary.skipped)
    }`,
  );
  return summary;
}
