import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Inbox, AlertTriangle, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";
import { ThreadsThreadCard } from "./ThreadsThreadCard";
import { buildThreadsReplyThreads } from "./threadsReplyTree";
import { ThreadsRepliesPermissionAlert } from "./ThreadsRepliesPermissionAlert";

interface Props {
  accountId: string | null;
  replies: ThreadsReply[];
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  showApproval?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  onReplyClick?: (reply: ThreadsReply) => void;
}

export function ThreadsReplyList({
  accountId,
  replies,
  isLoading,
  error,
  onRetry,
  showApproval,
  emptyTitle,
  emptyDescription,
  onReplyClick,
}: Props) {
  const { t } = useTranslation("threads");
  const threads = useMemo(() => buildThreadsReplyThreads(replies), [replies]);
  const title = emptyTitle ?? t("empty.noReplies", "No replies yet");
  const description = emptyDescription ?? t("empty.repliesWillAppear", "Replies on this thread will appear here.");

  if (isLoading) {
    return (
      <div className="space-y-3">
        {[0, 1, 2].map((i) => (
          <Card key={i}>
            <CardContent className="p-4 space-y-3">
              <div className="flex items-center gap-3">
                <Skeleton className="h-9 w-9 rounded-full" />
                <div className="space-y-2 flex-1">
                  <Skeleton className="h-3 w-32" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="h-4 w-full" />
              <Skeleton className="h-4 w-3/4" />
            </CardContent>
          </Card>
        ))}
      </div>
    );
  }

  if (error) {
    const reason = (error as { reason?: string })?.reason;
    if (reason === "missing_scope" || reason === "permission_not_approved" || reason === "expired_token") {
      return <ThreadsRepliesPermissionAlert reason={reason} />;
    }
    if (reason === "rate_limited") {
      return (
        <Card>
          <CardContent className="p-6 text-center space-y-3">
            <Clock className="h-6 w-6 text-muted-foreground mx-auto" />
            <p className="text-sm text-muted-foreground">
              {t("errors.rateLimited", "You're loading replies too quickly. Please wait a moment.")}
            </p>
            {onRetry && (
              <Button variant="outline" size="sm" onClick={onRetry}>{t("common:retry", "Retry")}</Button>
            )}
          </CardContent>
        </Card>
      );
    }
    return (
      <Card>
        <CardContent className="p-6 text-center space-y-3">
          <AlertTriangle className="h-6 w-6 text-destructive mx-auto" />
          <p className="text-sm text-muted-foreground">
            {(error as Error)?.message || t("errors.failedLoadReplies", "Failed to load replies.")}
          </p>
          {onRetry && (
            <Button variant="outline" size="sm" onClick={onRetry}>{t("common:retry", "Retry")}</Button>
          )}
        </CardContent>
      </Card>
    );
  }

  if (threads.length === 0) {
    return (
      <Card>
        <CardContent className="p-8 text-center space-y-2">
          <Inbox className="h-6 w-6 text-muted-foreground mx-auto" />
          <p className="text-sm font-medium">{title}</p>
          <p className="text-xs text-muted-foreground">{description}</p>
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
          showApproval={showApproval}
          onReplyClick={onReplyClick}
        />
      ))}
    </div>
  );
}
