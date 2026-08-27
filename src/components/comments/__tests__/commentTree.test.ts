import { describe, expect, it } from "vitest";
import { buildCommentThreads } from "@/components/comments/commentTree";
import type { Comment } from "@/hooks/useCommentInbox";

function comment(id: string, created_time: string, parent_id?: string): Comment {
  return {
    id,
    author_name: `author-${id}`,
    message: `message-${id}`,
    created_time,
    parent_id,
    is_reply: Boolean(parent_id),
    platform: "facebook",
  };
}

describe("buildCommentThreads", () => {
  it("puts a reply inside its parent's thread instead of beside it", () => {
    const threads = buildCommentThreads([
      comment("root", "2026-08-27T10:00:00Z"),
      comment("reply", "2026-08-27T10:05:00Z", "root"),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("root");
    expect(threads[0].replyCount).toBe(1);
    expect(threads[0].nodes.map((n) => n.comment.id)).toEqual(["root", "reply"]);
  });

  it("records how deep each reply sits so the frame can colour it", () => {
    const threads = buildCommentThreads([
      comment("root", "2026-08-27T10:00:00Z"),
      comment("child", "2026-08-27T10:01:00Z", "root"),
      comment("grandchild", "2026-08-27T10:02:00Z", "child"),
    ]);

    expect(threads[0].nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(threads[0].replyCount).toBe(2);
  });

  // The case that decides whether a customer's message can vanish: Meta pages the
  // comments edge, and the caller filters before threading, so a reply routinely
  // arrives without the comment it answers.
  it("promotes a reply whose parent is absent rather than dropping it", () => {
    const threads = buildCommentThreads([
      comment("orphan", "2026-08-27T10:00:00Z", "a-comment-on-another-page"),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("orphan");
    expect(threads[0].nodes[0].depth).toBe(0);
  });

  it("orders roots newest-first and replies oldest-first", () => {
    const threads = buildCommentThreads([
      comment("older-root", "2026-08-27T09:00:00Z"),
      comment("newer-root", "2026-08-27T11:00:00Z"),
      comment("second-reply", "2026-08-27T09:20:00Z", "older-root"),
      comment("first-reply", "2026-08-27T09:10:00Z", "older-root"),
    ]);

    expect(threads.map((t) => t.root.id)).toEqual(["newer-root", "older-root"]);
    expect(threads[1].nodes.map((n) => n.comment.id)).toEqual([
      "older-root",
      "first-reply",
      "second-reply",
    ]);
  });

  it("keeps every comment exactly once across all threads", () => {
    const input = [
      comment("a", "2026-08-27T10:00:00Z"),
      comment("b", "2026-08-27T10:01:00Z", "a"),
      comment("c", "2026-08-27T10:02:00Z"),
      comment("d", "2026-08-27T10:03:00Z", "b"),
    ];

    const seen = buildCommentThreads(input).flatMap((t) => t.nodes.map((n) => n.comment.id));

    expect(seen.sort()).toEqual(["a", "b", "c", "d"]);
  });

  // Two comments naming each other are both "replies", so neither qualifies as a root.
  // Rendering only from roots dropped them from the page without a trace.
  it("still shows comments caught in a parent cycle", () => {
    const threads = buildCommentThreads([
      comment("self", "2026-08-27T10:00:00Z", "self"),
      comment("x", "2026-08-27T10:01:00Z", "y"),
      comment("y", "2026-08-27T10:02:00Z", "x"),
    ]);

    const seen = threads.flatMap((t) => t.nodes.map((n) => n.comment.id));
    expect(seen.sort()).toEqual(["self", "x", "y"]);
  });

  it("returns nothing for an empty list", () => {
    expect(buildCommentThreads([])).toEqual([]);
  });
});
