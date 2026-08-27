import type { ThreadsReply } from "@/hooks/useThreadsReplies";
import { buildThreads, type Thread } from "@/lib/threadTree";

export type ThreadsReplyThread = Thread<ThreadsReply>;

/**
 * Threads names the entry a reply answers in `replied_to`, and that is sometimes the post
 * itself rather than another reply. A top-level reply must root its own thread, so the
 * post is not treated as a parent -- otherwise every reply on a post looks like the child
 * of something that is not in the list, which the shared walk would then promote back to
 * a root anyway, but only after building the wrong shape for anything nested beneath it.
 *
 * This is the only Threads-specific rule in the threading path; the walk itself is shared
 * with the Facebook and Instagram comment inbox.
 */
export function buildThreadsReplyThreads(replies: ThreadsReply[]): ThreadsReplyThread[] {
  return buildThreads(replies, {
    id: (reply) => reply.id,
    parentId: (reply) => {
      const parentId = reply.replied_to?.id;
      return parentId && parentId !== reply.root_post?.id ? parentId : null;
    },
    createdAt: (reply) => reply.timestamp,
  });
}
