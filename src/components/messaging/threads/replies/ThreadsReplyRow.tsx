import { formatDistanceToNow } from "date-fns";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  CornerDownRight,
  ExternalLink,
  Eye,
  EyeOff,
  MoreHorizontal,
  Reply as ReplyIcon,
  Check,
  X as XIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ThreadsReply } from "@/hooks/useThreadsReplies";
import { useThreadsReplyMutations } from "@/hooks/useThreadsReplies";
import { TopicTagDebugView } from "@/components/history/TopicTagDebugView";
import { useThreadsAuthorAvatarContext } from "@/components/messaging/threads/ThreadsAuthorAvatarContext";
import { depthIndent, depthStyle } from "@/components/comments/commentDepth";
import type { ThreadNode } from "@/lib/threadTree";

interface Props {
  accountId: string | null;
  node: ThreadNode<ThreadsReply>;
  showApproval?: boolean;
  onReplyClick?: (reply: ThreadsReply) => void;
}

/**
 * One reply inside a thread frame.
 *
 * This was a Card of its own until the frame moved up to the thread. A card per reply
 * made every reply look like a separate item on the page, which is exactly what a nested
 * conversation is not; the rail colour and the logical inset say who is answering whom,
 * and the frame around the whole thread says where the conversation starts and ends.
 */
export function ThreadsReplyRow({ accountId, node, showApproval, onReplyClick }: Props) {
  const { entry: reply, depth } = node;
  const style = depthStyle(depth);
  const { hide, unhide, approve, reject } = useThreadsReplyMutations(accountId);
  const isHidden = reply.hide_status === "HIDDEN";
  const isPending = reply.hide_status === "PENDING";
  const isOwned = !!reply.is_reply_owned_by_me;
  const { getAvatar, selfAvatar, selfUsername } = useThreadsAuthorAvatarContext();
  const username =
    reply.username ?? (isOwned ? selfUsername ?? "Unknown User" : "Unknown User");
  const avatarUrl = isOwned ? selfAvatar ?? getAvatar(username) : getAvatar(username);
  const topicTagDebug =
    (reply as unknown as { topic_tag_debug?: Record<string, unknown> }).topic_tag_debug ||
    ((reply as unknown as { raw_data?: { topic_tag_debug?: Record<string, unknown> } }).raw_data
      ?.topic_tag_debug);

  return (
    <div style={{ marginInlineStart: depthIndent(depth) }}>
      <div
        className={cn(
          "flex gap-2 rounded-md",
          depth > 0 && ["ps-1.5", style.tint],
          isHidden && "opacity-60",
        )}
      >
        {depth > 0 && <span className={cn("w-1 shrink-0 rounded-full", style.rail)} aria-hidden />}

        <div className="min-w-0 flex-1 py-2">
          <div className="flex items-start gap-3">
            <Avatar className="h-9 w-9 shrink-0">
              {avatarUrl && (
                <AvatarImage src={avatarUrl} alt={username} referrerPolicy="no-referrer" />
              )}
              <AvatarFallback className="text-xs">
                {username.slice(0, 2).toUpperCase()}
              </AvatarFallback>
            </Avatar>

            <div className="flex-1 min-w-0 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <div className="flex flex-wrap items-center gap-2 min-w-0">
                  {depth > 0 && (
                    <CornerDownRight className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden />
                  )}
                  <span className={cn("font-medium text-sm truncate", style.name)}>@{username}</span>
                  {reply.timestamp && (
                    <span className="text-xs text-muted-foreground">
                      {formatDistanceToNow(new Date(reply.timestamp), { addSuffix: true })}
                    </span>
                  )}
                  {isOwned && <Badge variant="secondary" className="text-[10px]">You</Badge>}
                  {isHidden && <Badge variant="outline" className="text-[10px]">Hidden</Badge>}
                  {isPending && <Badge variant="default" className="text-[10px]">Pending</Badge>}
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  {showApproval && isPending ? (
                    <>
                      <Button
                        size="sm"
                        variant="default"
                        className="h-7 px-2 text-xs"
                        onClick={() => approve.mutate(reply.id)}
                        disabled={approve.isPending}
                      >
                        <Check className="h-3.5 w-3.5 mr-1" />
                        Approve
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 px-2 text-xs"
                        onClick={() => reject.mutate(reply.id)}
                        disabled={reject.isPending}
                      >
                        <XIcon className="h-3.5 w-3.5 mr-1" />
                        Reject
                      </Button>
                    </>
                  ) : onReplyClick ? (
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 px-2 text-xs"
                      onClick={() => onReplyClick(reply)}
                    >
                      <ReplyIcon className="h-3.5 w-3.5 mr-1" />
                      Reply
                    </Button>
                  ) : null}

                  {reply.permalink && (
                    <Button size="sm" variant="ghost" className="h-7 px-2 text-xs" asChild>
                      <a href={reply.permalink} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="h-3.5 w-3.5 mr-1" />
                        View
                      </a>
                    </Button>
                  )}

                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button size="sm" variant="ghost" className="h-7 w-7 p-0">
                        <MoreHorizontal className="h-4 w-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      {isHidden ? (
                        <DropdownMenuItem
                          onClick={() => unhide.mutate(reply.id)}
                          disabled={unhide.isPending}
                        >
                          <Eye className="h-4 w-4 mr-2" /> Unhide reply
                        </DropdownMenuItem>
                      ) : (
                        <DropdownMenuItem
                          onClick={() => hide.mutate(reply.id)}
                          disabled={hide.isPending}
                        >
                          <EyeOff className="h-4 w-4 mr-2" /> Hide reply
                        </DropdownMenuItem>
                      )}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </div>
              </div>

              {reply.text && (
                <p className="text-sm whitespace-pre-wrap break-words">{reply.text}</p>
              )}

              {reply.media_url && reply.media_type === "IMAGE" && (
                <img
                  src={reply.media_url}
                  alt={reply.text || username}
                  loading="lazy"
                  className="max-h-64 rounded-md border object-contain"
                />
              )}
              {reply.media_url && reply.media_type === "VIDEO" && (
                <video
                  src={reply.media_url}
                  poster={reply.thumbnail_url ?? undefined}
                  controls
                  className="max-h-64 rounded-md border"
                />
              )}

              {topicTagDebug && <TopicTagDebugView debug={topicTagDebug as Record<string, unknown>} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
