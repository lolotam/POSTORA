import { Card, CardContent } from "@/components/ui/card";
import { MessageSquare } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";
import { ThreadsReplyRow } from "./ThreadsReplyRow";
import type { ThreadsReplyThread } from "./threadsReplyTree";

interface Props {
  thread: ThreadsReplyThread;
  accountId: string | null;
  showApproval?: boolean;
  onReplyClick?: (reply: ThreadsReply) => void;
}

/**
 * One conversation in one frame: the reply somebody left, and everything beneath it.
 *
 * The frame is the point. Rendered as a flat run of cards, a reply and the reply it
 * answers are two unrelated items that happen to sit near each other. The card boundary
 * says "this is one exchange"; the depth colour inside says who is answering whom.
 */
export function ThreadsThreadCard({ thread, accountId, showApproval, onReplyClick }: Props) {
  const { t } = useTranslation("threads");
  const { nodes, replyCount } = thread;

  return (
    <Card>
      <CardContent className="space-y-1 p-3 sm:p-4">
        {replyCount > 0 && (
          <div className="flex items-center gap-2 pb-1">
            <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
              <MessageSquare className="h-3 w-3" />
              {replyCount === 1
                ? t("count.oneReply", "1 reply")
                : t("count.replies", "{{count}} replies", { count: replyCount })}
            </span>
          </div>
        )}

        {nodes.map((node) => (
          <ThreadsReplyRow
            key={node.entry.id}
            node={node}
            accountId={accountId}
            showApproval={showApproval}
            onReplyClick={onReplyClick}
          />
        ))}
      </CardContent>
    </Card>
  );
}
