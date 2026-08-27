import type { Comment } from "@/hooks/useCommentInbox";
import { buildThreads, type Thread, type ThreadNode } from "@/lib/threadTree";

export type CommentNode = ThreadNode<Comment>;
export type CommentThread = Thread<Comment>;

export { descendantCount } from "@/lib/threadTree";

/**
 * Facebook and Instagram both arrive flat with `parent_id` set on replies -- Facebook via
 * the `stream` filter on the comments edge, Instagram via the nested `replies` edge that
 * `parseIgComments` flattens. The walk itself is shared with Threads; see threadTree.
 */
export function buildCommentThreads(comments: Comment[]): CommentThread[] {
  return buildThreads(comments, {
    id: (comment) => comment.id,
    parentId: (comment) => comment.parent_id,
    createdAt: (comment) => comment.created_time,
  });
}
