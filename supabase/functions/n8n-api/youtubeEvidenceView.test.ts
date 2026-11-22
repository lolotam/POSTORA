import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { youtubeEvidenceOf } from "./youtubeEvidenceView.ts";

Deno.test("settled evidence is allowlisted with honest unknown where unobserved", () => {
  const view = youtubeEvidenceOf({
    youtube_video_id: "AbcD1234eFg",
    access_token: "must-not-leak",
    youtube_publish_evidence: {
      requested_privacy: "private",
      effective_privacy: "unknown",
      thumbnail: { state: "applied", reason: null },
      first_comment: { state: "unknown", reason: "answer_lost" },
      provider_body: { mustNotLeak: true },
    },
  }, "youtube");
  assertEquals(view, {
    requested_privacy: "private",
    effective_privacy: "unknown",
    thumbnail: { state: "applied", reason: null },
    first_comment: { state: "unknown", reason: "answer_lost" },
  });
  assertEquals(JSON.stringify(view).includes("must-not-leak"), false);
});

Deno.test("each destination is viewed independently and a disconnected one stays without evidence", () => {
  const destinations = [
    { platform: "youtube", response_data: { youtube_publish_evidence: {
      requested_privacy: "unlisted", effective_privacy: "unlisted",
      thumbnail: { state: "failed", reason: "refused" },
      first_comment: { state: "not_requested", reason: null },
    } } },
    { platform: "youtube", response_data: { youtube_video_id: "only-a-receipt" } },
    { platform: "instagram", response_data: { youtube_publish_evidence: { requested_privacy: "public" } } },
  ];
  const views = destinations.map((row) => youtubeEvidenceOf(row.response_data, row.platform));
  assertEquals(views[0]?.first_comment, { state: "not_requested", reason: null });
  assertEquals(views[0]?.thumbnail, { state: "failed", reason: "refused" });
  assertEquals(views[1], undefined);
  assertEquals(views[2], undefined);
});

Deno.test("malformed states fall back to unknown instead of claiming success", () => {
  const view = youtubeEvidenceOf({
    youtube_publish_evidence: {
      requested_privacy: "public",
      effective_privacy: "malicious",
      thumbnail: { state: "applied", reason: "unexpected-reason" },
      first_comment: { state: "applied" },
    },
  }, "youtube");
  assertEquals(view?.effective_privacy, "unknown");
  assertEquals(view?.thumbnail, { state: "applied", reason: null });
  assertEquals(view?.first_comment, { state: "applied", reason: null });
});
