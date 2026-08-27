import { describe, expect, it } from "vitest";
import { buildThreadsReplyThreads } from "../threadsReplyTree";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";

const POST = "post-1";

function reply(
  id: string,
  timestamp: string | null,
  repliedTo: string | null = POST,
): ThreadsReply {
  return {
    id,
    text: `text-${id}`,
    username: `user-${id}`,
    timestamp,
    root_post: { id: POST },
    replied_to: repliedTo ? { id: repliedTo } : null,
  };
}

describe("buildThreadsReplyThreads", () => {
  it("keeps a reply to the post itself as its own thread", () => {
    const threads = buildThreadsReplyThreads([
      reply("a", "2026-08-27T10:00:00Z"),
      reply("b", "2026-08-27T10:01:00Z"),
    ]);

    expect(threads.map((t) => t.root.id)).toEqual(["b", "a"]);
    expect(threads.every((t) => t.replyCount === 0)).toBe(true);
  });

  it("nests a reply that answers another reply", () => {
    const threads = buildThreadsReplyThreads([
      reply("root", "2026-08-27T10:00:00Z"),
      reply("child", "2026-08-27T10:05:00Z", "root"),
      reply("grandchild", "2026-08-27T10:06:00Z", "child"),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].nodes.map((n) => n.entry.id)).toEqual(["root", "child", "grandchild"]);
    expect(threads[0].nodes.map((n) => n.depth)).toEqual([0, 1, 2]);
    expect(threads[0].replyCount).toBe(2);
  });

  // The old buildTimeline keyed children by parent id, so a self-parented reply landed in
  // its own child list. On its own it then vanished -- `walk(null)` never reached it. It
  // took a second entry sharing that id to make `walk` recurse into the list forever. Both
  // outcomes are wrong; the walk is bounded now and the entry survives either way.
  it("survives a reply that names itself as its parent", () => {
    const threads = buildThreadsReplyThreads([reply("loop", "2026-08-27T10:00:00Z", "loop")]);

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("loop");
    expect(threads[0].nodes[0].depth).toBe(0);
  });

  // Two replies naming each other are both "children", so neither was reachable from a
  // root and both vanished from the page without a trace.
  it("still shows replies caught in a parent cycle", () => {
    const threads = buildThreadsReplyThreads([
      reply("x", "2026-08-27T10:00:00Z", "y"),
      reply("y", "2026-08-27T10:01:00Z", "x"),
    ]);

    const seen = threads.flatMap((t) => t.nodes.map((n) => n.entry.id));
    expect(seen.sort()).toEqual(["x", "y"]);
  });

  // Threads pages its conversation edge, so a reply routinely arrives without the reply
  // it answers. Dropping it would hide a real customer message.
  it("promotes a reply whose parent is on another page", () => {
    const threads = buildThreadsReplyThreads([
      reply("orphan", "2026-08-27T10:00:00Z", "a-reply-we-did-not-fetch"),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].root.id).toBe("orphan");
  });

  // ThreadsReply.timestamp is optional. Left as NaN it makes every comparison false, so
  // the sort returns an arbitrary order rather than an obviously wrong one.
  it("orders a reply with no timestamp last instead of at random", () => {
    const threads = buildThreadsReplyThreads([
      reply("undated", null),
      reply("older", "2026-08-27T09:00:00Z"),
      reply("newer", "2026-08-27T11:00:00Z"),
    ]);

    expect(threads.map((t) => t.root.id)).toEqual(["newer", "older", "undated"]);
  });

  // The direction that a first version got wrong: substituting epoch for "no date" made
  // an undated reply the OLDEST inside a thread, so it rendered above the reply it was
  // answering while correctly sorting last among roots.
  it("orders an undated reply last inside a thread too, not first", () => {
    const threads = buildThreadsReplyThreads([
      reply("root", "2026-08-27T09:00:00Z"),
      reply("undated", null, "root"),
      reply("first", "2026-08-27T09:10:00Z", "root"),
      reply("second", "2026-08-27T09:20:00Z", "root"),
    ]);

    expect(threads).toHaveLength(1);
    expect(threads[0].nodes.map((n) => n.entry.id)).toEqual([
      "root",
      "first",
      "second",
      "undated",
    ]);
  });

  // Codex review, PR #40: a descendant of a cycle was rooted before the cycle itself was
  // walked, so a reply with a perfectly good parent became a thread of its own at depth 0.
  it("keeps a cycle's descendant under its parent instead of promoting it", () => {
    const threads = buildThreadsReplyThreads([
      reply("x", "2026-08-27T10:00:00Z", "y"),
      reply("y", "2026-08-27T10:01:00Z", "x"),
      reply("z", "2026-08-27T10:02:00Z", "x"),
    ]);

    expect(threads).toHaveLength(1);
    const byId = new Map(threads[0].nodes.map((n) => [n.entry.id, n.depth]));
    expect([...byId.keys()].sort()).toEqual(["x", "y", "z"]);
    expect(byId.get("z")).toBeGreaterThan(0);
    expect(threads[0].replyCount).toBe(2);
  });

  it("returns nothing for an empty list", () => {
    expect(buildThreadsReplyThreads([])).toEqual([]);
  });
});
