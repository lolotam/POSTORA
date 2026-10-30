import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  candidateMedia,
  expectedMediaType,
  isRetryRun,
  parseMediaList,
  RETRY_LOOKBACK_MS,
  retryGuardDecision,
  retryWindowStart,
} from "./instagramRetryGuard.ts";

const post = { caption: " Mirror reel 🪞 ", notBeforeMs: Date.parse("2026-10-30T15:00:00Z"), mediaType: "VIDEO" };
const live = {
  id: "m1",
  caption: "Mirror reel 🪞",
  timestamp: "2026-10-30T15:03:26+0000",
  permalink: "https://www.instagram.com/reel/a/",
  media_type: "VIDEO",
};
const none = new Set<string>();

Deno.test("a retry finds the post live once and records it instead of posting it again", () => {
  const matches = candidateMedia([{ id: "m0", caption: "Other" }, live], post, none);
  assertEquals(retryGuardDecision(matches), { kind: "already_live", media: live });
});

Deno.test("two live copies are never posted a third time, and no copy's id is guessed", () => {
  assertEquals(retryGuardDecision(candidateMedia([live, { ...live, id: "m2" }], post, none)), { kind: "already_live_copies", count: 2 });
});

Deno.test("another post with the same caption is not this post: recorded media, or another media type", () => {
  // A duplicated post went live and is recorded on its own row; this post failed for a real reason.
  assertEquals(retryGuardDecision(candidateMedia([live], post, new Set(["m1"]))), { kind: "publish" });
  assertEquals(retryGuardDecision(candidateMedia([{ ...live, media_type: "IMAGE" }], post, none)), { kind: "publish" });
});

Deno.test("no match, an older match, or no caption publishes as before", () => {
  assertEquals(retryGuardDecision(candidateMedia([], post, none)), { kind: "publish" });
  assertEquals(retryGuardDecision(candidateMedia([{ ...live, timestamp: "2026-10-29T15:03:26+0000" }], post, none)), { kind: "publish" });
  assertEquals(retryGuardDecision(candidateMedia([live], { ...post, caption: "   " }, none)), { kind: "publish" });
});

Deno.test("only a run over a post an earlier run finished is a retry", () => {
  assertEquals(isRetryRun("failed", false), true);
  assertEquals(isRetryRun("completed", false), true);
  for (const status of ["pending", "scheduled", "processing", null]) assertEquals(isRetryRun(status, false), false);
  assertEquals(isRetryRun("failed", true), false);
});

Deno.test("the window opens before the later of creation and schedule", () => {
  const created = "2026-10-30T14:00:00Z";
  const scheduled = "2026-10-30T15:00:00Z";
  assertEquals(retryWindowStart({ created_at: created, scheduled_at: scheduled }), Date.parse(scheduled) - RETRY_LOOKBACK_MS);
  assertEquals(retryWindowStart({ created_at: created, scheduled_at: null }), Date.parse(created) - RETRY_LOOKBACK_MS);
});

Deno.test("only several images publish as a carousel; a video post is one reel", () => {
  assertEquals(expectedMediaType("IMAGE", 3), "CAROUSEL_ALBUM");
  assertEquals(expectedMediaType("IMAGE", 1), "IMAGE");
  assertEquals(expectedMediaType("VIDEO", 1), "VIDEO");
  assertEquals(expectedMediaType("VIDEO", 3), "VIDEO");
});

Deno.test("a media list with any malformed entry is unreadable, so the retry publishes as before", () => {
  assertEquals(parseMediaList(undefined), []);
  assertEquals(parseMediaList([live]), [live]);
  assertEquals(parseMediaList({ items: [] }), null);
  assertEquals(parseMediaList([null]), null);
  assertEquals(parseMediaList([{ id: "m1", caption: "x" }]), null);
});

Deno.test("an entry without a media type never stops a publish", () => {
  const { media_type: _type, ...untyped } = live;
  assertEquals(retryGuardDecision(candidateMedia([untyped], post, none)), { kind: "publish" });
});
