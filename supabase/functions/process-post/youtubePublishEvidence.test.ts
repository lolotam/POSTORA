import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  withYoutubePublishEvidence,
  youtubeEvidenceFromMetadata,
  youtubePublishEvidence,
} from "./youtubePublishEvidence.ts";

Deno.test("an unverified publish keeps requested and effective privacy apart", () => {
  const evidence = youtubePublishEvidence({
    requestedPrivacy: "unlisted",
    thumbnailRequested: true,
    commentRequested: false,
  });
  assertEquals(evidence.requested_privacy, "unlisted");
  assertEquals(evidence.effective_privacy, "unknown");
  assertEquals(evidence.thumbnail, { state: "unknown", reason: null });
  assertEquals(evidence.first_comment, { state: "not_requested", reason: null });
});

Deno.test("thumbnail and first-comment outcomes stay independent and reasons are sanitized", () => {
  const evidence = youtubePublishEvidence({
    requestedPrivacy: "private",
    effectivePrivacy: "private",
    thumbnailRequested: true,
    thumbnailState: "failed",
    thumbnailReason: "download_failed",
    commentRequested: true,
    commentState: "applied",
    commentReason: "https://secret.invalid/upload_id=xyz",
  });
  assertEquals(evidence.thumbnail, { state: "failed", reason: "download_failed" });
  assertEquals(evidence.first_comment, { state: "applied", reason: null });
});

Deno.test("evidence is additive and never replaces earlier response keys", () => {
  const result = withYoutubePublishEvidence(
    { youtube_upload_reason: "youtube_upload_completed", warnings: ["option"] },
    youtubePublishEvidence({ requestedPrivacy: "private", thumbnailRequested: false, commentRequested: false }),
  );
  assertEquals(result.youtube_upload_reason, "youtube_upload_completed");
  assertEquals(result.warnings, ["option"]);
  assertEquals((result.youtube_publish_evidence as { requested_privacy: string }).requested_privacy, "private");
});

// ───────────────────────────────────────────────────────────────────────────
// The schedule the evidence records
//
// A scheduled upload is private, whatever the post's privacy field says, and
// the row has to say whether the provider took the schedule or why it did
// not.
// ───────────────────────────────────────────────────────────────────────────

/** A time the provider can be given: an hour ahead is well inside the bounds. */
const FUTURE_PUBLISH_AT = new Date(Date.now() + 60 * 60_000).toISOString();

Deno.test("a publish that asked for no schedule records no schedule", () => {
  const evidence = youtubeEvidenceFromMetadata({ youtube_visibility: "public" });

  assertEquals(evidence.requested_privacy, "public");
  assertEquals(evidence.requested_publish_at, null);
  assertEquals(evidence.scheduled, false);
  assertEquals(evidence.schedule_warning, null);
});

Deno.test("a scheduled publish records the schedule and the privacy it really had", () => {
  const evidence = youtubeEvidenceFromMetadata({
    youtube_visibility: "public",
    youtube_publish_at: FUTURE_PUBLISH_AT,
  });

  // The post asked for public, and the video was uploaded private.
  assertEquals(evidence.requested_privacy, "private");
  assertEquals(evidence.scheduled, true);
  assertEquals(evidence.schedule_warning, null);
  assertEquals(evidence.requested_publish_at, FUTURE_PUBLISH_AT);
});

Deno.test("a schedule that cannot be honoured records the warning", () => {
  const evidence = youtubeEvidenceFromMetadata({
    youtube_visibility: "public",
    youtube_publish_at: "not-a-date",
  });

  assertEquals(evidence.requested_privacy, "private");
  assertEquals(evidence.scheduled, false);
  assertEquals(evidence.schedule_warning, "stale_schedule");
  // What was asked for is kept, so a reader sees the request that failed.
  assertEquals(evidence.requested_publish_at, "not-a-date");
});

Deno.test("an observed schedule wins over the value the post carried", () => {
  const evidence = youtubeEvidenceFromMetadata(
    { youtube_visibility: "public", youtube_publish_at: FUTURE_PUBLISH_AT },
    { scheduled: false, scheduleWarning: "stale_schedule" },
  );

  assertEquals(evidence.scheduled, false);
  assertEquals(evidence.schedule_warning, "stale_schedule");
  assertEquals(evidence.requested_publish_at, FUTURE_PUBLISH_AT);

  // Conversely, when the upload was scheduled at open time and finishes later
  // after the 15-minute lead has passed, the observed `scheduled: true` wins
  // and does not re-evaluate against settlement time to invent a stale warning.
  const soonPublishAt = new Date(Date.now() + 10 * 60_000).toISOString();
  const kept = youtubeEvidenceFromMetadata(
    { youtube_visibility: "public", youtube_publish_at: soonPublishAt },
    { scheduled: true, scheduleWarning: null },
  );
  assertEquals(kept.scheduled, true);
  assertEquals(kept.schedule_warning, null);
  assertEquals(kept.requested_publish_at, soonPublishAt);
});
