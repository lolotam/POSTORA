/**
 * Groups a flat list into one thread per root, for any conversation that arrives flat
 * with each entry naming the entry it answers.
 *
 * This lived inside the comment inbox until Threads turned out to be carrying a second
 * copy of the same walk -- one that had never received the fixes this one did, so a
 * Threads reply caught in a parent cycle still vanished from the page. Two copies of a
 * rule that decides whether a customer's message is shown at all is one copy too many.
 *
 * Nothing platform-specific belongs here. Which field holds the parent, and whether a
 * given parent even counts as one, are the caller's accessors.
 */

export interface ThreadNode<T> {
  entry: T;
  depth: number;
  replies: ThreadNode<T>[];
}

/** One root entry and every reply beneath it, flattened in reading order. */
export interface Thread<T> {
  root: T;
  /** Root first, then each descendant depth-first. What the UI renders in one frame. */
  nodes: ThreadNode<T>[];
  replyCount: number;
}

/** How to read the three fields the walk needs off whatever is being threaded. */
export interface ThreadKeys<T> {
  id: (entry: T) => string;
  /** Null starts a thread. A parent that is not in the list starts one too. */
  parentId: (entry: T) => string | null | undefined;
  createdAt: (entry: T) => string | null | undefined;
}

/**
 * Every reply beneath a node, at any depth.
 *
 * Meta deletes a comment's whole subtree with it, so the delete dialog has to name the
 * full count -- direct replies alone understate what the button removes.
 *
 * Iterative for the reason given on buildThreads: this runs per row on every render, and
 * a deep chain must not be able to take the page down.
 */
export function descendantCount<T>(node: ThreadNode<T>): number {
  let total = 0;
  const pending: ThreadNode<T>[] = [...node.replies];
  while (pending.length > 0) {
    const current = pending.pop() as ThreadNode<T>;
    total += 1;
    for (const reply of current.replies) pending.push(reply);
  }
  return total;
}

/**
 * Threads' timestamp is optional and Meta has returned unparseable ones, either of which
 * yields NaN. NaN comparisons are all false, so a single bad value makes a sort return an
 * arbitrary order rather than an obviously wrong one. Null says "no usable date" so the
 * comparators can place it deliberately.
 */
function timeOf(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Undated entries sort last in BOTH directions.
 *
 * Substituting epoch for "no date" is what a first version did, and it only looks right
 * from one end: epoch is the largest value under newest-first and the smallest under
 * oldest-first, so the same undated reply sank to the bottom of the root list and rose to
 * the top of a conversation -- above the reply it was answering. An entry we cannot place
 * in time should never displace one we can.
 */
function byTime<T>(
  createdAt: (entry: T) => string | null | undefined,
  direction: "newest" | "oldest",
) {
  return (a: T, b: T): number => {
    const left = timeOf(createdAt(a));
    const right = timeOf(createdAt(b));
    if (left === null || right === null) {
      if (left === right) return 0;
      return left === null ? 1 : -1;
    }
    return direction === "newest" ? right - left : left - right;
  };
}

/**
 * Groups a flat list into one thread per root entry.
 *
 * An entry is a root when it names no parent, or when its parent is not in this list.
 * That second case is not an edge case to tolerate but the normal one: callers filter
 * (hidden/visible, sentiment) before threading, and Meta pages its edges, so a reply
 * routinely arrives without the entry it answers. Dropping those would hide real
 * customer messages, so they are promoted rather than discarded.
 *
 * Roots run newest-first to match the flat lists this replaced; replies within a thread
 * run oldest-first, because a thread reads as a conversation.
 */
export function buildThreads<T>(entries: T[], keys: ThreadKeys<T>): Thread<T>[] {
  const newestFirst = byTime(keys.createdAt, "newest");
  const nodeOldestFirst = byTime<ThreadNode<T>>((node) => keys.createdAt(node.entry), "oldest");

  // Keyed by id rather than a bare Set: the stranded sweep below has to climb parent
  // links, which needs the entries themselves and not just their presence.
  const byId = new Map<string, T>();
  for (const entry of entries) byId.set(keys.id(entry), entry);
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];

  for (const entry of entries) {
    const parentId = keys.parentId(entry);
    if (!parentId || !byId.has(parentId) || parentId === keys.id(entry)) {
      roots.push(entry);
      continue;
    }
    const siblings = childrenOf.get(parentId) || [];
    siblings.push(entry);
    childrenOf.set(parentId, siblings);
  }

  // Meta has never returned a cycle, but a reply chain that closed on itself would hang
  // the walk rather than render wrong, so the visited set makes that impossible.
  const visited = new Set<string>();

  // Both walks below use an explicit stack rather than recursion. Depth here is the length
  // of a parent chain, which Threads does not bound -- and the ceiling is lower than it
  // looks: a chain of 2,000 builds fine, 5,000 throws RangeError and takes the page with
  // it. Facebook and Instagram nest at most one level, so this is Threads' exposure, and
  // the cost of not having it is a white screen rather than a wrong order.
  const build = (root: T): ThreadNode<T> => {
    const rootNode: ThreadNode<T> = { entry: root, depth: 0, replies: [] };
    visited.add(keys.id(root));
    const pending: ThreadNode<T>[] = [rootNode];
    while (pending.length > 0) {
      const node = pending.pop() as ThreadNode<T>;
      for (const child of childrenOf.get(keys.id(node.entry)) || []) {
        if (visited.has(keys.id(child))) continue;
        visited.add(keys.id(child));
        const childNode: ThreadNode<T> = { entry: child, depth: node.depth + 1, replies: [] };
        node.replies.push(childNode);
        pending.push(childNode);
      }
      node.replies.sort(nodeOldestFirst);
    }
    return rootNode;
  };

  /** Pre-order: the node, then each subtree in reply order. What one frame renders. */
  const flatten = (rootNode: ThreadNode<T>): ThreadNode<T>[] => {
    const ordered: ThreadNode<T>[] = [];
    const pending: ThreadNode<T>[] = [rootNode];
    while (pending.length > 0) {
      const node = pending.pop() as ThreadNode<T>;
      ordered.push(node);
      for (let i = node.replies.length - 1; i >= 0; i--) pending.push(node.replies[i]);
    }
    return ordered;
  };

  const thread = (root: T): Thread<T> => {
    const nodes = flatten(build(root));
    return { root, nodes, replyCount: nodes.length - 1 };
  };

  const threads = [...roots].sort(newestFirst).map(thread);

  /**
   * Where a stranded entry's thread should actually start.
   *
   * Promoting the stranded entry itself is only right when that entry is ON the cycle.
   * Given x<->y with z answering x, the newest-first sweep reaches z first, roots z, and
   * marks it visited -- so when x is finally walked it skips z, and a reply that has a
   * perfectly good parent ends up as a thread of its own at depth 0. Climbing to the
   * cycle first puts all three in one thread with z under x, where it belongs.
   */
  const cycleRootOf = (entry: T): T => {
    const climbed = new Set<string>();
    let current = entry;
    for (;;) {
      const id = keys.id(current);
      if (climbed.has(id)) return current;
      climbed.add(id);
      const parentId = keys.parentId(current);
      if (!parentId || parentId === id || visited.has(parentId)) return current;
      const parent = byId.get(parentId);
      if (!parent) return current;
      current = parent;
    }
  };

  // A parent cycle -- a naming b while b names a -- leaves both looking like replies, so
  // neither lands in `roots` and both would disappear from the page entirely. The visited
  // set above stops the walk hanging; this is what stops the entries vanishing.
  for (const stranded of [...entries].sort(newestFirst)) {
    if (!visited.has(keys.id(stranded))) threads.push(thread(cycleRootOf(stranded)));
  }

  return threads.sort((a, b) => newestFirst(a.root, b.root));
}
