/**
 * What an upload hands to the outer loop.
 *
 * The upload is settled through the fenced settlement, because only the worker
 * that still owns the upload may record the outcome. A settlement that is
 * REFUSED -- or whose answer was lost -- leaves the row open: the row exists,
 * it belongs to this attempt, and the upload recovery owns it.
 *
 * WHY THE ANSWER IS "PENDING" AND NOT "FAILED"
 * --------------------------------------------
 * A failure rolls the parent up: the post becomes "failed" and the customer
 * is told that the publication is over. But the row under it is still open, so
 * the post would be terminal while one of its destinations is still being
 * recorded -- and that row would be offered as a retry, which could publish a
 * second video on the customer's channel.
 *
 * A pending destination keeps the parent PROCESSING. The upload recovery
 * settles the row when it is done, and only then does the post roll up.
 *
 * The handoff lives here, in one module, so that the publisher and the outer
 * loop cannot disagree about what an unrecorded outcome means.
 */

import type { YoutubeUploadSessionStore } from "./youtubeResumableUpload.ts";
import { redactProviderText } from "./youtubeUploadPolicy.ts";

/** The part of the store that records the outcome of an upload. */
export type YoutubeUploadSettlementPort = Pick<YoutubeUploadSessionStore, "settle">;

/** Whether the outcome was recorded, and why not when it was not. */
export interface YoutubeUploadSettlement {
  confirmed: boolean;
  reason: string | null;
}

/**
 * What the publisher hands to the outer loop after it tried to settle.
 *
 * "settled" means the row is closed and the rollup may go on. "pending" means
 * the row is still open: the outer loop leaves it alone, keeps the post
 * processing, and hands the row to the upload recovery with its id.
 */
export type YoutubeUploadHandoff =
  | { kind: "settled" }
  | {
      kind: "pending";
      /** The outer loop keeps the row open and the post processing. */
      pendingContinuation: true;
      /** The row that is still open. */
      pendingPlatformPostId?: string;
    };

/**
 * Records the outcome of an upload, and says whether it was recorded.
 *
 * A refusal and a lost answer are the same thing for the caller: the outcome
 * is not on the row, so the row stays open. Neither of them is allowed to
 * throw, because the upload already wrote to the provider and the row has to
 * be settled by whoever owns it next.
 */
export async function settleYoutubeUpload(
  store: YoutubeUploadSettlementPort,
  sessionId: string,
  leaseToken: string,
  args: {
    status: "success" | "failed";
    videoId?: string | null;
    errorMessage?: string | null;
    responseData?: Record<string, unknown>;
  },
): Promise<YoutubeUploadSettlement> {
  try {
    const settled = await store.settle({
      sessionId,
      leaseToken,
      status: args.status,
      videoId: args.videoId ?? null,
      errorMessage: args.errorMessage ?? null,
      responseData: args.responseData ?? {},
    });
    if (!settled.settled) {
      console.error(`[youtube] the upload outcome was not recorded: ${settled.refused ?? "unknown"}`);
      return { confirmed: false, reason: settled.refused ?? "unknown" };
    }
    return { confirmed: true, reason: null };
  } catch (error) {
    console.error("[youtube] the upload outcome was not confirmed:", redactProviderText(error));
    return { confirmed: false, reason: "answer_lost" };
  }
}

/**
 * The handoff of a settlement.
 *
 * A confirmed settlement is the final word: the row is closed, and the outer
 * loop may roll the post up. An unconfirmed one leaves the row open, so the
 * answer is a pending destination, and the row travels with it so that the
 * recovery settles THAT row and not another one.
 */
export function youtubeUploadHandoff(
  settlement: YoutubeUploadSettlement,
  pendingPlatformPostId?: string | null,
): YoutubeUploadHandoff {
  if (settlement.confirmed) return { kind: "settled" };
  return {
    kind: "pending",
    pendingContinuation: true,
    ...(pendingPlatformPostId ? { pendingPlatformPostId } : {}),
  };
}

/**
 * The row a destination that left its row open contributes to the post.
 *
 * PENDING, never failed: the row is still open, so the destination has not
 * failed -- it has not finished. The post stays processing until the
 * destination that owns the row settles it.
 */
export function pendingDestinationResult(platform: string): { platform: string; status: "pending" } {
  return { platform, status: "pending" };
}
