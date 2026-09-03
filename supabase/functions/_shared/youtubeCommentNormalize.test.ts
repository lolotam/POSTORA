import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { threadToInputs } from "./youtubeCommentNormalize.ts";

const thread = {
  id: "t1",
  videoId: "v1",
  parentId: null,
  text: "hello",
  authorChannelId: "UC-ann",
  authorName: "Ann",
  authorAvatar: null,
  publishedAt: "2026-09-01T00:00:00Z",
  likeCount: 2,
  moderationStatus: null,
  totalReplyCount: 1,
  replies: [{
    id: "r1",
    videoId: "v1",
    parentId: "t1",
    text: "hi",
    authorChannelId: "UC-me",
    authorName: "Me",
    authorAvatar: null,
    publishedAt: "2026-09-01T01:00:00Z",
    likeCount: 0,
    moderationStatus: null,
  }],
};

Deno.test("a thread becomes one comment input plus one per inlined reply", () => {
  const inputs = threadToInputs(thread);
  assertEquals(
    inputs.map((input) => [
      input.comment.id,
      input.comment.kind,
      input.comment.parentCommentId,
    ]),
    [["t1", "comment", null], ["r1", "reply", "t1"]],
  );
  assertEquals(inputs[0].post, {
    id: "v1",
    url: "https://www.youtube.com/watch?v=v1",
    caption: null,
  });
  assertEquals(inputs[0].author, {
    id: "UC-ann",
    name: "Ann",
    username: null,
  });
  assertEquals(inputs[0].timestamp, "2026-09-01T00:00:00Z");
});
