import { useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Check, Archive, ExternalLink, Loader2, AtSign, Reply, CheckCircle2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { ThreadsMention, ThreadsMentionStatus, MentionMetaPatch } from "@/hooks/useThreadsMentions";
import { ThreadsSentimentBadge } from "./ThreadsSentimentBadge";
import { ThreadsStatusBadge } from "./ThreadsStatusBadge";
import { ThreadsLabelsEditor } from "./ThreadsLabelsEditor";
import { ThreadsAssigneePicker } from "./ThreadsAssigneePicker";
import { ThreadsReplyComposer } from "./ThreadsReplyComposer";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useThreadsAuthorAvatarContext } from "./ThreadsAuthorAvatarContext";
import { ThreadsMentionConversation } from "./ThreadsMentionConversation";

interface ThreadsMentionCardProps {
  mention: ThreadsMention;
  isUpdating?: boolean;
  isReplying?: boolean;
  isMetaUpdating?: boolean;
  onMarkRead: (id: string) => void;
  onArchive: (id: string) => void;
  onReply?: (id: string, text: string) => void;
  onMetaChange?: (id: string, patch: MentionMetaPatch) => void;
  onStatusChange?: (id: string, status: ThreadsMentionStatus) => void;
}

export function ThreadsMentionCard({
  mention,
  isUpdating = false,
  isReplying = false,
  isMetaUpdating = false,
  onMarkRead,
  onArchive,
  onReply,
  onMetaChange,
  onStatusChange,
}: ThreadsMentionCardProps) {
  const { flags } = useFeatureFlags();
  const [composerOpen, setComposerOpen] = useState(false);
  const author = mention.mention_author_username || "unknown";
  const initials = author.slice(0, 2).toUpperCase();
  const { getAvatar } = useThreadsAuthorAvatarContext();
  const avatarUrl = mention.mention_author_avatar_url || getAvatar(author);
  const timeLabel = mention.mentioned_at
    ? formatDistanceToNow(new Date(mention.mentioned_at), { addSuffix: true })
    : "Unknown time";
  const repliedLabel = mention.replied_at
    ? formatDistanceToNow(new Date(mention.replied_at), { addSuffix: true })
    : null;

  const handleSentiment = (v: ThreadsMention["sentiment"]) => {
    onMetaChange?.(mention.id, { sentiment: v });
  };
  const handleLabels = (next: string[]) => {
    onMetaChange?.(mention.id, { labels: next });
  };
  const handleAssign = (next: string | null) => {
    onMetaChange?.(mention.id, { assigned_to: next });
  };
  const handleStatusChange = (next: ThreadsMentionStatus) => {
    if (onStatusChange) {
      onStatusChange(mention.id, next);
      return;
    }
    if (next === "read") onMarkRead(mention.id);
    else if (next === "archived") onArchive(mention.id);
  };
  const handleReplySubmit = (text: string) => {
    onReply?.(mention.id, text);
    setComposerOpen(false);
  };

  return (
    <Card className="transition-colors hover:bg-accent/30">
      <CardContent className="p-4 space-y-3">
        {/* Header */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <Avatar className="h-9 w-9 shrink-0">
              {avatarUrl && (
                <AvatarImage
                  src={avatarUrl}
                  alt={author}
                  referrerPolicy="no-referrer"
                />
              )}
              <AvatarFallback className="bg-primary/10 text-primary text-xs font-semibold">
                {initials}
              </AvatarFallback>
            </Avatar>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-sm font-medium truncate">
                <AtSign className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                <span className="truncate">{author}</span>
              </div>
              <p className="text-xs text-muted-foreground">{timeLabel}</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <ThreadsStatusBadge
              value={mention.status}
              disabled={isUpdating}
              onChange={handleStatusChange}
            />
            {onMetaChange && (
              <ThreadsSentimentBadge
                value={mention.sentiment}
                disabled={isMetaUpdating}
                onChange={handleSentiment}
              />
            )}
          </div>
        </div>

        {/* Mention text */}
        {mention.mention_text && (
          <p className="text-sm text-foreground whitespace-pre-wrap break-words leading-relaxed">
            {mention.mention_text}
          </p>
        )}

        {/* Labels + assignment */}
        {(onMetaChange || mention.labels.length > 0 || mention.assigned_to) && (
          <div className="flex flex-wrap items-center justify-between gap-2">
            {onMetaChange ? (
              <ThreadsLabelsEditor
                labels={mention.labels}
                disabled={isMetaUpdating}
                onChange={handleLabels}
              />
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {mention.labels.map((l) => (
                  <Badge key={l} variant="secondary">#{l}</Badge>
                ))}
              </div>
            )}
            {flags.msgThreadsAssignment && onMetaChange && (
              <ThreadsAssigneePicker
                assignedTo={mention.assigned_to}
                disabled={isMetaUpdating}
                onChange={handleAssign}
              />
            )}
          </div>
        )}

        {/* Replied summary */}
        {mention.has_reply && mention.reply_text && (
          <div className="rounded-md border border-emerald-500/20 bg-emerald-500/5 p-2.5 text-xs space-y-1">
            <div className="flex items-center gap-1.5 text-emerald-700 dark:text-emerald-300 font-medium">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Replied {repliedLabel}
            </div>
            <p className="text-foreground/80 whitespace-pre-wrap break-words">
              {mention.reply_text}
            </p>
            {mention.reply_permalink && (
              <a
                href={mention.reply_permalink}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 text-primary hover:underline"
              >
                <ExternalLink className="h-3 w-3" />
                Open reply on Threads
              </a>
            )}
          </div>
        )}

        {/* Reply error */}
        {mention.reply_error && !mention.has_reply && (
          <p className="text-xs text-destructive">Last reply failed: {mention.reply_error}</p>
        )}

        {/* Reply composer */}
        {composerOpen && onReply && (
          <ThreadsReplyComposer
            isPending={isReplying}
            onCancel={() => setComposerOpen(false)}
            onSubmit={handleReplySubmit}
          />
        )}

        {/* Action buttons */}
        <div className="flex flex-wrap items-center gap-2 pt-1">
          {mention.status === "new" && (
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdating}
              onClick={() => onMarkRead(mention.id)}
            >
              {isUpdating ? (
                <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
              ) : (
                <Check className="h-3.5 w-3.5 mr-1.5" />
              )}
              Mark as Read
            </Button>
          )}
          {mention.status !== "archived" && (
            <Button
              size="sm"
              variant="outline"
              disabled={isUpdating}
              onClick={() => onArchive(mention.id)}
            >
              <Archive className="h-3.5 w-3.5 mr-1.5" />
              Archive
            </Button>
          )}
          {flags.msgThreadsReply && onReply && !composerOpen && (
            <Button
              size="sm"
              variant={mention.has_reply ? "outline" : "default"}
              disabled={isReplying}
              onClick={() => setComposerOpen(true)}
            >
              <Reply className="h-3.5 w-3.5 mr-1.5" />
              {mention.has_reply ? "Reply again" : "Reply"}
            </Button>
          )}
          {mention.mention_permalink && (
            <Button size="sm" variant="ghost" asChild>
              <a
                href={mention.mention_permalink}
                target="_blank"
                rel="noopener noreferrer"
              >
                <ExternalLink className="h-3.5 w-3.5 mr-1.5" />
                Open in Threads
              </a>
            </Button>
          )}
        </div>

        <ThreadsMentionConversation
          socialAccountId={mention.social_account_id}
          threadsMediaId={mention.threads_media_id}
        />
      </CardContent>
    </Card>
  );
}
