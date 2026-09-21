import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import { useThreadConversation, useThreadPost } from "@/hooks/useThreadsReplies";
import { ThreadsReplyList } from "@/components/messaging/threads/replies/ThreadsReplyList";

interface Props {
  socialAccountId: string;
  threadsMediaId: string | null;
}

/**
 * The thread a mention sits in, fetched only when somebody asks to see it.
 *
 * Loading it with the mention list would mean one Graph call per mention on every render
 * of the page -- the reply quota this account is billed against is the same one the quota
 * card warns about, and a list of forty mentions would spend forty calls to render
 * conversations nobody opened. Passing null until `open` keeps both queries disabled, so
 * the cost lands on the click that asked for it.
 *
 * Two calls, not one, and the first is not optional. `threads_mentions.threads_media_id`
 * holds the MENTION's id -- the ingest writes `r.id` -- while Meta's conversation edge is
 * documented on the original post and answers `{"data":[]}` for anything else. Verified
 * against a live mention: `/{mention_id}/conversation` came back empty while
 * `/{root_post.id}/conversation` returned the real thread. So the mention is resolved to
 * its root post first, and only then is the conversation requested.
 */
export function ThreadsMentionConversation({ socialAccountId, threadsMediaId }: Props) {
  const { t } = useTranslation("threads");
  const [open, setOpen] = useState(false);

  const {
    data: mentionPost,
    isLoading: resolvingPost,
    error: postError,
    refetch: refetchPost,
  } = useThreadPost(open ? socialAccountId : null, open ? threadsMediaId : null);

  // A mention that IS a top-level post has no root_post of its own; it is its own thread.
  const rootPostId = mentionPost?.root_post?.id ?? (mentionPost ? threadsMediaId : null);

  const {
    data: replies = [],
    isLoading: loadingConversation,
    error: conversationError,
    refetch: refetchConversation,
  } = useThreadConversation(open ? socialAccountId : null, rootPostId);

  // A failed lookup leaves rootPostId null, which DISABLES the conversation query -- so
  // without this the card would report "no replies on this thread", which is a different
  // claim from "we could not find out", and the retry button would re-run a query that
  // is not the one that failed.
  const failure = postError ?? conversationError;
  const retry = postError ? refetchPost : refetchConversation;

  // Threads only tells us which post a mention belongs to when it gives us a media id.
  // Without one there is no conversation to fetch, so offering the control would be a lie.
  if (!threadsMediaId) return null;

  return (
    <div className="mt-3 border-t pt-3">
      <Button
        size="sm"
        variant="ghost"
        className="h-7 px-2 text-xs"
        onClick={() => setOpen((current) => !current)}
        aria-expanded={open}
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 me-1.5" /> : <ChevronRight className="h-3.5 w-3.5 me-1.5" />}
        <MessagesSquare className="h-3.5 w-3.5 me-1.5" />
        {open ? t("actions.hideConversation", "Hide conversation") : t("actions.showConversation", "Show conversation")}
      </Button>

      {open && (
        <div className="mt-2">
          <ThreadsReplyList
            accountId={socialAccountId}
            replies={replies}
            isLoading={resolvingPost || loadingConversation}
            error={failure ?? undefined}
            onRetry={() => retry()}
            emptyTitle={t("empty.noRepliesOnThread", "No replies on this thread")}
            emptyDescription={t("empty.noRepliesOnThreadHint", "Nobody has replied to the post this mention sits in.")}
          />
        </div>
      )}
    </div>
  );
}
