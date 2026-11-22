import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  withYoutubePublishEvidence,
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
