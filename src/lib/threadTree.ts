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
 */
export function descendantCount<T>(node: ThreadNode<T>): number {
  return node.replies.reduce((total, reply) => total + 1 + descendantCount(reply), 0);
}

/**
 * Threads' timestamp is optional and Meta has returned unparseable ones, either of which
 * yields NaN. NaN comparisons are all false, so a single bad value makes the sort return
 * an arbitrary order rather than an obviously wrong one. Epoch sorts it last instead.
 */
function timeOf(value: string | null | undefined): number {
  if (!value) return 0;
  const parsed = new Date(value).getTime();
  return Number.isNaN(parsed) ? 0 : parsed;
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
  const newestFirst = (a: T, b: T) => timeOf(keys.createdAt(b)) - timeOf(keys.createdAt(a));
  const oldestFirst = (a: ThreadNode<T>, b: ThreadNode<T>) =>
    timeOf(keys.createdAt(a.entry)) - timeOf(keys.createdAt(b.entry));

  const present = new Set(entries.map(keys.id));
  const childrenOf = new Map<string, T[]>();
  const roots: T[] = [];

  for (const entry of entries) {
    const parentId = keys.parentId(entry);
    if (!parentId || !present.has(parentId) || parentId === keys.id(entry)) {
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

  const build = (entry: T, depth: number): ThreadNode<T> => {
    visited.add(keys.id(entry));
    const replies = (childrenOf.get(keys.id(entry)) || [])
      .filter((child) => !visited.has(keys.id(child)))
      .map((child) => build(child, depth + 1))
      .sort(oldestFirst);
    return { entry, depth, replies };
  };

  const flatten = (node: ThreadNode<T>): ThreadNode<T>[] => [node, ...node.replies.flatMap(flatten)];
  const thread = (root: T): Thread<T> => {
    const nodes = flatten(build(root, 0));
    return { root, nodes, replyCount: nodes.length - 1 };
  };

  const threads = [...roots].sort(newestFirst).map(thread);

  // A parent cycle -- a naming b while b names a -- leaves both looking like replies, so
  // neither lands in `roots` and both would disappear from the page entirely. The visited
  // set above stops the walk hanging; this is what stops the entries vanishing. Anything
  // still unwalked becomes its own thread and pulls its cycle partner in beneath it.
  for (const stranded of [...entries].sort(newestFirst)) {
    if (!visited.has(keys.id(stranded))) threads.push(thread(stranded));
  }

  return threads.sort((a, b) => newestFirst(a.root, b.root));
}
