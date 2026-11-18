/**
 * The contract of one upload outcome.
 *
 * An upload ends in one of three ways, and every part of the system has to
 * agree on which one it was:
 *
 *   * a PROOF: the upload never started, or the provider refused it. The
 *     customer may retry it, because nothing reached the channel.
 *   * an UNCERTAIN outcome: the provider may already hold a video that nobody
 *     has a receipt for. The public marker says so, so neither the retry gate
 *     in the database nor the retry button on the page offers it.
 *   * a SUCCESS: the provider named the video.
 *
 * The rules live here, in one place, because two paths settle an upload: the
 * publisher that uploaded it and the continuation that carries it on. A rule
 * that exists twice is a rule that will disagree.
 */

import type { ResumableUploadOutcome } from "./youtubeResumableUpload.ts";
import {
  YOUTUBE_UPLOAD_REASON,
  youtubeUploadPublicMessage,
  type YoutubeUploadReason,
} from "./youtubeUploadPolicy.ts";

/**
 * Whether an outcome leaves the provider holding a video nobody has a receipt
 * for.
 *
 * A proof says what happened to the video: it never started, or the provider
 * refused it. Everything else leaves the provider holding a video nobody has
 * a receipt for, and the public marker says exactly that.
 */
export function isUncertainUploadOutcome(outcome: {
  kind: string;
  reason?: YoutubeUploadReason;
}): boolean {
  return outcome.kind === "reconcile" || outcome.reason === YOUTUBE_UPLOAD_REASON.unknown;
}

/**
 * The reason code one outcome carries.
 *
 * The outcome's own reason is the answer, with one exception: an upload that
 * never sent a byte is recorded as the UNSENT reason, because that is the
 * reason the customer can act on.
 */
export function youtubeUploadOutcomeReason(outcome: ResumableUploadOutcome): YoutubeUploadReason {
  switch (outcome.kind) {
    case "unsent":
      return YOUTUBE_UPLOAD_REASON.unsent;
    case "completed":
      return YOUTUBE_UPLOAD_REASON.completed;
    default:
      return outcome.reason;
  }
}

/**
 * The message an upload outcome becomes.
 *
 * The wording matters as much as the branch: a refusal that needs a human
 * must never read like "safe to try again", because trying again could put a
 * second video on the customer's channel.
 *
 * The reason is the outcome's OWN reason, because the reasons are not the
 * same thing: a provider that refused the upload has answered, and a
 * credential that is no longer accepted needs the customer to reconnect. The
 * customer is told which one it was, without the provider's own words.
 */
export function youtubeUploadOutcomeMessage(outcome: ResumableUploadOutcome): string {
  switch (outcome.kind) {
    case "resumable":
      return `${youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.resumable)} (${outcome.reason})`;
    case "unsent":
      return `${youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.unsent)} (${outcome.reason})`;
    case "reconcile":
      return `${youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.reconcile)} (${outcome.reason})`;
    case "abandoned":
      // The reason says why the write was not made: the live state refused it,
      // or the lease was gone. It is the outcome's own reason, not a guess.
      return `${youtubeUploadPublicMessage(outcome.reason)} (${outcome.reason})`;
    case "failed":
      return `${youtubeUploadPublicMessage(outcome.reason)} (${outcome.reason})`;
    default:
      return youtubeUploadPublicMessage(YOUTUBE_UPLOAD_REASON.completed);
  }
}

/**
 * The message an UNCONFIRMED settlement becomes.
 *
 * A settlement whose answer was lost, or that was refused because the lease
 * was gone, leaves the row to the upload recovery: the row exists, it belongs
 * to this attempt, and the receipt is already stored, so nothing is uploaded
 * a second time. The message says that, so the customer is never told that a
 * retry is safe when it is not.
 */
export function youtubeUploadUnconfirmedMessage(outcome: ResumableUploadOutcome): string {
  return `${youtubeUploadOutcomeMessage(outcome)} The result was not recorded, so the upload recovery will settle it.`;
}

/**
 * What the public row records about a failed upload.
 *
 * The marker is what the retry gate in the database and the retry selector on
 * the page read, so an outcome that is not a proof carries it and a proven
 * failure does not.
 */
export function youtubeUploadFailureResponseData(
  outcome: ResumableUploadOutcome,
): Record<string, unknown> {
  const reason = youtubeUploadOutcomeReason(outcome);
  return {
    youtube_upload_reason: reason,
    ...(isUncertainUploadOutcome(outcome) ? { publish_outcome: "uncertain" } : {}),
  };
}

/**
 * The error an upload hands to the outer loop.
 *
 * The public row was ADMITTED before the provider was contacted, so it exists
 * and it belongs to this attempt. The error says so, and the outer loop then
 * leaves the row alone: the upload recovery owns it, and it settles the row
 * when the upload is finished.
 *
 * Without that, a settlement whose answer was lost would let the generic
 * writer record a SECOND row for the same destination: beside the pending row
 * the admission made, or beside the success that already committed.
 *
 * The row id travels with the error because the scope of the attempt needs
 * it: the closure reads the scope, and a scope that names a destination
 * without a result row is refused, so the fanout could never close.
 */
export function uploadOwnedFailure(
  message: string,
  ids: { platformPostId?: string | null; videoId?: string | null },
): Error & { selfWroteRows?: boolean; platformPostId?: string | null; videoId?: string | null } {
  const failure = new Error(message) as Error & {
    selfWroteRows?: boolean;
    platformPostId?: string | null;
    videoId?: string | null;
  };
  failure.selfWroteRows = true;
  failure.platformPostId = ids.platformPostId ?? null;
  failure.videoId = ids.videoId ?? null;
  return failure;
}
