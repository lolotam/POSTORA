import { useState } from "react";
import { Button } from "@/components/ui/button";
import { ChevronDown, ChevronRight, MessagesSquare } from "lucide-react";
import { useThreadConversation } from "@/hooks/useThreadsReplies";
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
 * conversations nobody opened. Passing null until `open` keeps the query disabled, so the
 * cost lands on the click that asked for it.
 */
export function ThreadsMentionConversation({ socialAccountId, threadsMediaId }: Props) {
  const [open, setOpen] = useState(false);
  const {
    data: replies = [],
    isLoading,
    error,
    refetch,
  } = useThreadConversation(open ? socialAccountId : null, open ? threadsMediaId : null);

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
        {open ? <ChevronDown className="h-3.5 w-3.5 mr-1.5" /> : <ChevronRight className="h-3.5 w-3.5 mr-1.5" />}
        <MessagesSquare className="h-3.5 w-3.5 mr-1.5" />
        {open ? "Hide conversation" : "Show conversation"}
      </Button>

      {open && (
        <div className="mt-2">
          <ThreadsReplyList
            accountId={socialAccountId}
            replies={replies}
            isLoading={isLoading}
            error={error ?? undefined}
            onRetry={() => refetch()}
            emptyTitle="No replies on this thread"
            emptyDescription="Nobody has replied to the post this mention sits in."
          />
        </div>
      )}
    </div>
  );
}
