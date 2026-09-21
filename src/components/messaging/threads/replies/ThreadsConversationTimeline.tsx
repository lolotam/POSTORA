import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";
import { Card, CardContent } from "@/components/ui/card";
import { Inbox } from "lucide-react";
import { ThreadsThreadCard } from "./ThreadsThreadCard";
import { buildThreadsReplyThreads } from "./threadsReplyTree";

interface Props {
  accountId: string | null;
  replies: ThreadsReply[];
  onReplyClick?: (reply: ThreadsReply) => void;
}

/**
 * The full conversation under one post, as framed threads rather than a flat run.
 *
 * This used to carry its own nesting walk. Two of its cases were wrong in ways the
 * comment inbox had already fixed: a reply naming itself as its parent recursed forever
 * and took the page down with it, and two replies naming each other left neither
 * reachable from a root, so both silently disappeared. The walk is now shared.
 */
export function ThreadsConversationTimeline({ accountId, replies, onReplyClick }: Props) {
  const { t } = useTranslation("threads");
  const threads = useMemo(() => buildThreadsReplyThreads(replies), [replies]);

  if (threads.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <Inbox className="h-6 w-6 text-muted-foreground mx-auto" />
          <p className="text-sm font-medium">{t("empty.noConversation", "No conversation yet")}</p>
          <p className="text-xs text-muted-foreground">
            {t("empty.conversationHint", "Once people reply on this thread, the conversation will appear here.")}
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <div className="space-y-3">
      {threads.map((thread) => (
        <ThreadsThreadCard
          key={thread.root.id}
          thread={thread}
          accountId={accountId}
          onReplyClick={onReplyClick}
        />
      ))}
    </div>
  );
}
