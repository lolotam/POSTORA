import type { Comment } from "@/hooks/useCommentInbox";

export interface CommentNode {
  comment: Comment;
  depth: number;
  replies: CommentNode[];
}

/** One root comment and every reply beneath it, flattened in reading order. */
export interface CommentThread {
  root: Comment;
  /** Root first, then each descendant depth-first. What the UI renders in one frame. */
  nodes: CommentNode[];
  replyCount: number;
}

const newestFirst = (a: Comment, b: Comment) =>
  new Date(b.created_time).getTime() - new Date(a.created_time).getTime();

const oldestFirst = (a: CommentNode, b: CommentNode) =>
  new Date(a.comment.created_time).getTime() - new Date(b.comment.created_time).getTime();

/**
 * Groups a flat comment list into one thread per root comment.
 *
 * A comment is a root when it names no parent, or when its parent is not in this list.
 * That second case is not an edge case to tolerate but the normal one: the caller
 * filters (hidden/visible, sentiment) before threading, and Meta pages the comments
 * edge, so a reply routinely arrives without the comment it answers. Dropping those
 * would hide real customer messages, so they are promoted rather than discarded.
 *
 * Roots are ordered newest-first to match the flat list this replaces; replies within a
 * thread run oldest-first, because a thread reads as a conversation.
 */
export function buildCommentThreads(comments: Comment[]): CommentThread[] {
  const present = new Set(comments.map((c) => c.id));
  const childrenOf = new Map<string, Comment[]>();
  const roots: Comment[] = [];

  for (const comment of comments) {
    const parentId = comment.parent_id;
    if (!parentId || !present.has(parentId) || parentId === comment.id) {
      roots.push(comment);
      continue;
    }
    const siblings = childrenOf.get(parentId) || [];
    siblings.push(comment);
    childrenOf.set(parentId, siblings);
  }

  // Meta has never returned a cycle, but a reply chain that closed on itself would hang
  // the walk rather than render wrong, so the visited set makes that impossible.
  const visited = new Set<string>();

  const build = (comment: Comment, depth: number): CommentNode => {
    visited.add(comment.id);
    const replies = (childrenOf.get(comment.id) || [])
      .filter((child) => !visited.has(child.id))
      .map((child) => build(child, depth + 1))
      .sort(oldestFirst);
    return { comment, depth, replies };
  };

  const flatten = (node: CommentNode): CommentNode[] => [node, ...node.replies.flatMap(flatten)];
  const thread = (root: Comment): CommentThread => {
    const nodes = flatten(build(root, 0));
    return { root, nodes, replyCount: nodes.length - 1 };
  };

  const threads = roots.sort(newestFirst).map(thread);

  // A parent cycle -- a naming b while b names a -- leaves both looking like replies, so
  // neither lands in `roots` and both would disappear from the page entirely. The visited
  // set above stops the walk hanging; this is what stops the comments vanishing. Anything
  // still unwalked becomes its own thread and pulls its cycle partner in beneath it.
  for (const stranded of [...comments].sort(newestFirst)) {
    if (!visited.has(stranded.id)) threads.push(thread(stranded));
  }

  return threads.sort((a, b) => newestFirst(a.root, b.root));
}
