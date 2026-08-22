import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { normalizeMetaCommentChange } from "./commentEvents.ts";

Deno.test("facebook feed comment add → comment input", () => {
  const out = normalizeMetaCommentChange("facebook", {
    field: "feed",
    value: { item: "comment", verb: "add", comment_id: "123_456", post_id: "123_789", from: { id: "u1", name: "Fan" }, message: "Hi", created_time: 1787392800 },
  });
  assertEquals(out, {
    comment: { id: "123_456", kind: "comment", text: "Hi", parentCommentId: null, mediaUrl: null },
    post: { id: "123_789", url: null, caption: null },
    author: { id: "u1", name: "Fan", username: null },
    timestamp: "2026-08-22T10:00:00.000Z",
  });
});

Deno.test("facebook feed reply (has parent_id) → kind reply", () => {
  const out = normalizeMetaCommentChange("facebook", {
    field: "feed",
    value: { item: "comment", verb: "add", comment_id: "c2", post_id: "p1", parent_id: "c1", from: { id: "u1", name: "Fan" }, message: "Re" },
  });
  assertEquals(out?.comment.kind, "reply");
  assertEquals(out?.comment.parentCommentId, "c1");
});

Deno.test("facebook non-add verbs and non-comment items are ignored", () => {
  assertEquals(normalizeMetaCommentChange("facebook", { field: "feed", value: { item: "comment", verb: "remove", comment_id: "c" } }), null);
  assertEquals(normalizeMetaCommentChange("facebook", { field: "feed", value: { item: "like", verb: "add" } }), null);
});

Deno.test("instagram comments change → comment input", () => {
  const out = normalizeMetaCommentChange("instagram", {
    field: "comments",
    value: { id: "17891", text: "Nice", from: { id: "ig-fan", username: "fan" }, media: { id: "m1", media_product_type: "FEED" } },
  });
  assertEquals(out, {
    comment: { id: "17891", kind: "comment", text: "Nice", parentCommentId: null, mediaUrl: null },
    post: { id: "m1", url: null, caption: null },
    author: { id: "ig-fan", name: null, username: "fan" },
    timestamp: undefined,
  });
});

Deno.test("unrelated fields are ignored", () => {
  assertEquals(normalizeMetaCommentChange("instagram", { field: "mentions", value: {} }), null);
});

// A like on a comment arrives on the same `feed` subscription and carries the SAME
// `comment_id` as the comment it is attached to. The webhook uses the normalized comment id
// as its idempotency claim precisely because of this: if a raw `value.comment_id` were
// claimed instead, this event would consume the real comment's only claim and the comment
// would be dropped as a duplicate. Meta does not guarantee delivery order.
Deno.test("a like carrying a comment_id is not a comment", () => {
  assertEquals(
    normalizeMetaCommentChange("facebook", {
      field: "feed",
      value: { item: "like", verb: "add", comment_id: "17841400000000000", post_id: "123_456" },
    }),
    null,
  );
});

// Same hazard for edits and reactions, which the `feed` subscription also delivers.
Deno.test("edits and reactions on a comment are not new comments", () => {
  for (const value of [
    { item: "comment", verb: "edited", comment_id: "c1", message: "changed" },
    { item: "reaction", verb: "add", comment_id: "c1" },
  ]) {
    assertEquals(normalizeMetaCommentChange("facebook", { field: "feed", value }), null);
  }
});
