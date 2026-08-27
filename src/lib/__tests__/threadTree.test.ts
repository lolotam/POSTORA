import { describe, expect, it } from "vitest";
import { buildThreads, descendantCount } from "@/lib/threadTree";

interface Entry {
  id: string;
  parent?: string;
  at?: string | null;
}

const keys = {
  id: (entry: Entry) => entry.id,
  parentId: (entry: Entry) => entry.parent,
  createdAt: (entry: Entry) => entry.at ?? "2026-08-27T10:00:00Z",
};

/** One entry answering the last, N deep -- the shape Threads can actually produce. */
function chain(length: number): Entry[] {
  return Array.from({ length }, (_, i) => ({
    id: `n${i}`,
    parent: i === 0 ? undefined : `n${i - 1}`,
  }));
}

describe("buildThreads depth", () => {
  // Recursion here is not a style question. Measured on this suite, a recursive walk
  // carried a 2,000-long chain and threw RangeError at 5,000 -- a blank page, not a
  // mis-sorted list. Threads does not bound how deep a reply chain goes, so the walks
  // use explicit stacks and this test is what stops recursion creeping back in.
  it("threads a chain far deeper than the recursive walk survived", () => {
    const threads = buildThreads(chain(10_000), keys);

    expect(threads).toHaveLength(1);
    expect(threads[0].nodes).toHaveLength(10_000);
    expect(threads[0].replyCount).toBe(9_999);
    expect(threads[0].nodes[9_999].depth).toBe(9_999);
  });

  it("counts descendants down a chain that deep without recursing", () => {
    const threads = buildThreads(chain(10_000), keys);

    expect(descendantCount(threads[0].nodes[0])).toBe(9_999);
  });

  it("keeps pre-order: a node, then its subtree, then the next sibling", () => {
    const threads = buildThreads([
      { id: "root", at: "2026-08-27T10:00:00Z" },
      { id: "a", parent: "root", at: "2026-08-27T10:01:00Z" },
      { id: "a1", parent: "a", at: "2026-08-27T10:02:00Z" },
      { id: "b", parent: "root", at: "2026-08-27T10:03:00Z" },
    ], keys);

    expect(threads[0].nodes.map((n) => n.entry.id)).toEqual(["root", "a", "a1", "b"]);
    expect(threads[0].nodes.map((n) => n.depth)).toEqual([0, 1, 2, 1]);
  });
});
