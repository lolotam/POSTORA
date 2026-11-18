/**
 * The contract of one upload outcome.
 *
 * Two paths settle an upload: the publisher that uploaded it and the
 * continuation that carries it on. They have to agree on three things, and
 * these are them:
 *
 *   * what counts as a PROOF, and what counts as an uncertain outcome;
 *   * what the public row records about a failure, because the marker in that
 *     record is what the retry gate and the retry button read;
 *   * what the outer loop is told when the upload owns a row that was admitted
 *     before the provider was contacted.
 *
 * The last one is the one that keeps a second result off the customer's
 * account: an error that says the row was written by this worker stops the
 * generic writer from recording a second one beside it.
 */

import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  isUncertainUploadOutcome,
  uploadOwnedFailure,
  uploadRefusalFailure,
  youtubeUploadFailureResponseData,
  youtubeUploadOutcomeMessage,
  youtubeUploadOutcomeReason,
} from "./youtubeUploadOutcome.ts";
import { YOUTUBE_UPLOAD_REASON, type YoutubeUploadReason } from "./youtubeUploadPolicy.ts";
import type { ResumableUploadOutcome } from "./youtubeResumableUpload.ts";

/** An upload that failed for good. */
function failed(reason: YoutubeUploadReason): ResumableUploadOutcome {
  return { kind: "failed", reason, retryable: false };
}

// ───────────────────────────────────────────────────────────────────────────
// What counts as a proof
// ───────────────────────────────────────────────────────────────────────────

Deno.test("an outcome the provider did not classify is uncertain", () => {
  assertEquals(isUncertainUploadOutcome({ kind: "failed", reason: YOUTUBE_UPLOAD_REASON.unknown }), true);
});

Deno.test("an outcome that may have published a video is uncertain", () => {
  assertEquals(isUncertainUploadOutcome({ kind: "reconcile", reason: YOUTUBE_UPLOAD_REASON.reconcile }), true);
});

Deno.test("a provider that refused the upload is a proof", () => {
  assertEquals(isUncertainUploadOutcome({ kind: "failed", reason: YOUTUBE_UPLOAD_REASON.rejected }), false);
});

Deno.test("an upload that never started is a proof", () => {
  assertEquals(isUncertainUploadOutcome({ kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent }), false);
});

Deno.test("a refusal that needs a human is a proof about the credential, not about the video", () => {
  // The account cannot publish. That is a proof about the credential, and the
  // customer has to reconnect, so the outcome is not uncertain: there is no
  // video the provider may be holding.
  assertEquals(
    isUncertainUploadOutcome({ kind: "failed", reason: YOUTUBE_UPLOAD_REASON.account_unusable }),
    false,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// What the public row records
// ───────────────────────────────────────────────────────────────────────────

Deno.test("an outcome that is not a proof carries the marker", () => {
  assertEquals(youtubeUploadFailureResponseData(failed(YOUTUBE_UPLOAD_REASON.unknown)), {
    youtube_upload_reason: YOUTUBE_UPLOAD_REASON.unknown,
    publish_outcome: "uncertain",
  });
});

Deno.test("a proven failure carries no marker, so it stays retryable", () => {
  // A provider that refused the upload, and a sibling account whose own file
  // was not ready: both are proofs about something other than the video, so
  // neither takes the whole post away from the retry button.
  assertEquals(youtubeUploadFailureResponseData(failed(YOUTUBE_UPLOAD_REASON.rejected)), {
    youtube_upload_reason: YOUTUBE_UPLOAD_REASON.rejected,
  });
  assertEquals(youtubeUploadFailureResponseData(failed(YOUTUBE_UPLOAD_REASON.media_unavailable)), {
    youtube_upload_reason: YOUTUBE_UPLOAD_REASON.media_unavailable,
  });
});

Deno.test("the reason of an outcome that never started is the one the customer can act on", () => {
  assertEquals(
    youtubeUploadOutcomeReason({ kind: "unsent", reason: YOUTUBE_UPLOAD_REASON.unsent }),
    YOUTUBE_UPLOAD_REASON.unsent,
  );
});

// ───────────────────────────────────────────────────────────────────────────
// What the customer is told
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a credential the provider no longer accepts asks for a reconnect", () => {
  const message = youtubeUploadOutcomeMessage(failed(YOUTUBE_UPLOAD_REASON.account_unusable));
  assertStringIncludes(message, "Reconnect it and retry");
  assertStringIncludes(message, YOUTUBE_UPLOAD_REASON.account_unusable);
});

Deno.test("a provider that refused the upload does not ask for a reconnect", () => {
  const message = youtubeUploadOutcomeMessage(failed(YOUTUBE_UPLOAD_REASON.rejected));
  assertStringIncludes(message, "YouTube refused this upload");
  assertEquals(message.includes("Reconnect"), false);
});

// ───────────────────────────────────────────────────────────────────────────
// What the outer loop is told
// ───────────────────────────────────────────────────────────────────────────

Deno.test("an owned failure says the worker wrote the rows and names the row", () => {
  const failure = uploadOwnedFailure("The upload did not finish.", { platformPostId: "row-1" });
  assertEquals(failure.selfWroteRows, true);
  assertEquals(failure.platformPostId, "row-1");
});

Deno.test("an owned failure without a row still stops the generic writer", () => {
  // The flag alone is what stops the generic writer. A failure that lost its
  // row id must still stop it, or a second result is recorded beside the
  // pending row the admission made.
  const failure = uploadOwnedFailure("The upload did not finish.", {});
  assertEquals(failure.selfWroteRows, true);
});

Deno.test("an owned failure carries the video id when there is one", () => {
  const failure = uploadOwnedFailure("The upload did not finish.", {
    platformPostId: "row-1",
    videoId: "abcdefghijk",
  });
  assertEquals(failure.videoId, "abcdefghijk");
});

// ───────────────────────────────────────────────────────────────────────────
// What a refusal is told
// ───────────────────────────────────────────────────────────────────────────

Deno.test("a refusal that may have published a video carries the marker", () => {
  // Two refusals say the same thing in different words: the channel may
  // already hold a video of this post, and the session needs a human. Both
  // have to stop the row from being offered as a retry.
  const channel = uploadRefusalFailure("channel_may_have_published", "The channel may already hold a video.");
  assertEquals(channel.responseData?.publish_outcome, "uncertain");
  assertEquals(channel.responseData?.youtube_upload_reason, YOUTUBE_UPLOAD_REASON.reconcile);

  const session = uploadRefusalFailure("reconcile_required", "YouTube may have a video from this upload.");
  assertEquals(session.responseData?.publish_outcome, "uncertain");
});

Deno.test("a refusal that is a proof carries no marker, so it stays retryable", () => {
  // Nothing reached the channel, so the customer may try again.
  const failure = uploadRefusalFailure("media_not_owned", "The video file is not yours.");
  assertEquals("responseData" in failure, false);
});
