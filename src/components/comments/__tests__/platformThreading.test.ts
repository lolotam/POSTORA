import { describe, expect, it } from "vitest";
import { parseIgComments, parsePageComments } from "@/hooks/useCommentInbox";
import { buildCommentThreads } from "@/components/comments/commentTree";

/**
 * Both platforms reach the same tree view, by different routes, and neither route is
 * obvious from the component that renders it: Facebook asks Meta for `comments.filter
 * (stream)` and reads `parent`, Instagram asks for a nested `replies` edge and flattens
 * it. These assert the whole path -- Graph payload in, nested thread out -- because a
 * change to either request shape breaks threading somewhere a component test would not
 * look.
 */

describe("Facebook payload threading", () => {
  it("nests a reply under the comment it answers", () => {
    const payload = {
      data: [{
        id: "post-1",
        message: "A post",
        comments: {
          data: [
            {
              id: "c-1",
              from: { id: "u1", name: "Asker" },
              message: "How much?",
              created_time: "2026-08-27T10:00:00Z",
            },
            {
              id: "c-2",
              from: { id: "u2", name: "Page" },
              message: "12 KWD",
              created_time: "2026-08-27T10:05:00Z",
              parent: { id: "c-1" },
            },
          ],
        },
      }],
    };

    const threads = buildCommentThreads(parsePageComments(payload));

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("c-1");
    expect(threads[0].nodes.map((n) => n.entry.id)).toEqual(["c-1", "c-2"]);
    expect(threads[0].nodes.map((n) => n.depth)).toEqual([0, 1]);
  });
});

describe("Instagram payload threading", () => {
  it("nests a reply from the replies edge under its comment", () => {
    const payload = {
      data: [{
        id: "media-1",
        caption: "A reel",
        media_type: "VIDEO",
        comments: {
          data: [
            {
              id: "ig-1",
              from: { id: "u1", username: "asker" },
              text: "Do you deliver?",
              timestamp: "2026-08-27T10:00:00Z",
              replies: {
                data: [
                  {
                    id: "ig-1-r1",
                    from: { id: "u2", username: "shop" },
                    text: "Yes, same day",
                    timestamp: "2026-08-27T10:04:00Z",
                  },
                  {
                    id: "ig-1-r2",
                    from: { id: "u1", username: "asker" },
                    text: "Great",
                    timestamp: "2026-08-27T10:09:00Z",
                  },
                ],
              },
            },
            {
              id: "ig-2",
              from: { id: "u3", username: "other" },
              text: "Nice",
              timestamp: "2026-08-27T11:00:00Z",
            },
          ],
        },
      }],
    };

    const parsed = parseIgComments(payload);
    expect(parsed.find((c) => c.id === "ig-1-r1")?.parent_id).toBe("ig-1");

    const threads = buildCommentThreads(parsed);

    // Two roots -- the standalone comment is newer, so it sorts first.
    expect(threads.map((t) => t.root.id)).toEqual(["ig-2", "ig-1"]);

    const conversation = threads[1];
    expect(conversation.replyCount).toBe(2);
    expect(conversation.nodes.map((n) => n.entry.id)).toEqual(["ig-1", "ig-1-r1", "ig-1-r2"]);
    // Instagram supports exactly one level of replies, so the tree is never deeper.
    expect(conversation.nodes.map((n) => n.depth)).toEqual([0, 1, 1]);
  });

  it("keeps a comment with no replies as a thread of its own", () => {
    const threads = buildCommentThreads(parseIgComments({
      data: [{
        id: "media-1",
        comments: { data: [{ id: "solo", username: "someone", text: "Hi", timestamp: "2026-08-27T10:00:00Z" }] },
      }],
    }));

    expect(threads).toHaveLength(1);
    expect(threads[0].replyCount).toBe(0);
  });
});
