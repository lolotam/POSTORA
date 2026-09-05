import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { errorTypeFor, groupThreadsByVideo } from "./youtubeCommentsView.ts";

const item = (id: string, videoId: string, author = "UC-ann") => ({
  id,
  raw: { id },
  videoId,
  parentId: null,
  text: id,
  authorChannelId: author,
  authorName: "n",
  authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z",
  likeCount: 0,
  moderationStatus: null,
  totalReplyCount: 0,
  replies: [],
});

Deno.test("threads are grouped per video, in the order first seen, with the title looked up", () => {
  const groups = groupThreadsByVideo(
    [item("a", "v1"), item("b", "v2"), item("c", "v1", "UC-me")],
    new Map([["v1", { title: "One", thumbnail: null }]]),
    "UC-me",
  );
  assertEquals(
    groups.map((group) => [group.id, group.title, group.threads.length]),
    [
      ["v1", "One", 2],
      ["v2", "", 1],
    ],
  );
  assertEquals(groups[0].threads[1].is_own, true);
  assertEquals(groups[0].url, "https://www.youtube.com/watch?v=v1");
});

Deno.test("adapter error classes map onto the comment manager's error_type vocabulary", () => {
  assertEquals(errorTypeFor("scope_missing"), "MISSING_SCOPE");
  assertEquals(errorTypeFor("unauthorized"), "TOKEN_EXPIRED");
  assertEquals(errorTypeFor("quota"), "QUOTA");
  assertEquals(errorTypeFor("upstream"), "YOUTUBE_ERROR");
});
