import { useState } from "react";
import { InboxMessage } from "@/hooks/useAdminInbox";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { format } from "date-fns";
import {
  ArrowDownLeft,
  ArrowUpRight,
  Trash2,
  Mail,
  Paperclip,
  Download,
  FileText,
  Image as ImageIcon,
  File,
  Reply,
  Forward,
  ChevronDown,
  ChevronUp,
  MessageSquare,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReplyData, ForwardData } from "./ComposeEmail";
import type { MessageThread } from "./ThreadedMessageList";

interface InboundAttachment {
  id?: string;
  filename: string;
  content_type: string;
  content_id?: string;
  content_disposition?: string;
  url?: string;
  size?: number;
}

function getAttachmentIcon(contentType: string) {
  if (contentType.startsWith("image/")) return ImageIcon;
  if (contentType.includes("pdf")) return FileText;
  return File;
}

function formatFileSize(bytes?: number): string {
  if (!bytes) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

interface SingleMessageProps {
  message: InboxMessage;
  isExpanded: boolean;
  onToggle: () => void;
  isLatest: boolean;
}

function SingleMessage({ message, isExpanded, onToggle, isLatest }: SingleMessageProps) {
  const isInbound = message.direction === "inbound";

  return (
    <Collapsible open={isExpanded} onOpenChange={onToggle}>
      <div
        className={cn(
          "border rounded-lg overflow-hidden",
          isLatest && "ring-2 ring-primary/20"
        )}
      >
        {/* Message Header - Always visible */}
        <CollapsibleTrigger asChild>
          <button className="w-full p-4 flex items-start gap-3 hover:bg-muted/50 transition-colors text-start">
            <div
              className={cn(
                "mt-0.5 p-1 rounded-full flex-shrink-0",
                isInbound
                  ? "bg-blue-500/10 text-blue-500"
                  : "bg-green-500/10 text-green-500"
              )}
            >
              {isInbound ? (
                <ArrowDownLeft className="w-3 h-3" />
              ) : (
                <ArrowUpRight className="w-3 h-3" />
              )}
            </div>

            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2">
                <span className="text-sm font-medium truncate">
                  {isInbound ? message.from_email : `To: ${message.to_email}`}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {format(new Date(message.created_at), "MMM d, h:mm a")}
                </span>
              </div>
              {!isExpanded && (
                <p className="text-xs text-muted-foreground truncate mt-0.5">
                  {message.body?.substring(0, 100) || "No content"}
                </p>
              )}
            </div>

            <div className="flex items-center gap-2">
              {Array.isArray(message.attachments) && message.attachments.length > 0 && (
                <Paperclip className="w-4 h-4 text-muted-foreground" />
              )}
              {isExpanded ? (
                <ChevronUp className="w-4 h-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="w-4 h-4 text-muted-foreground" />
              )}
            </div>
          </button>
        </CollapsibleTrigger>

        {/* Expanded Content */}
        <CollapsibleContent>
          <Separator />
          <div className="p-4 space-y-4">
            {/* Attachments */}
            {Array.isArray(message.attachments) && message.attachments.length > 0 && (
              <div className="space-y-2">
                <div className="flex items-center gap-2 text-sm">
                  <Paperclip className="w-4 h-4 text-muted-foreground" />
                  <span className="text-muted-foreground">
                    {message.attachments.length} attachment(s)
                  </span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {(message.attachments as InboundAttachment[]).map((attachment, index) => {
                    const Icon = getAttachmentIcon(
                      attachment.content_type || "application/octet-stream"
                    );
                    const hasUrl = attachment.url;

                    return (
                      <div
                        key={attachment.id || index}
                        className="flex items-center gap-2 px-3 py-2 bg-muted rounded-md text-sm"
                      >
                        <Icon className="w-4 h-4 text-muted-foreground" />
                        <span className="max-w-[150px] truncate" title={attachment.filename}>
                          {attachment.filename}
                        </span>
                        {attachment.size && (
                          <span className="text-xs text-muted-foreground">
                            ({formatFileSize(attachment.size)})
                          </span>
                        )}
                        {hasUrl && (
                          <a
                            href={attachment.url}
                            target="_blank"
                            rel="noopener noreferrer"
                            download={attachment.filename}
                            className="ms-1 text-primary hover:text-primary/80"
                            title="Download"
                            onClick={(e) => e.stopPropagation()}
                          >
                            <Download className="w-4 h-4" />
                          </a>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Body */}
            {message.html_body ? (
              <div
                className="prose prose-sm dark:prose-invert max-w-none max-md:overflow-x-auto max-md:break-words"
                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(message.html_body) }}
              />
            ) : (
              <pre className="text-sm whitespace-pre-wrap font-sans max-md:break-words">
                {message.body || "No content"}
              </pre>
            )}
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

interface ThreadDetailProps {
  thread: MessageThread | null;
  onDelete: (id: string) => void;
  onReply?: (data: ReplyData) => void;
  onForward?: (data: ForwardData) => void;
  onMarkAsRead?: (id: string) => void;
}

export function ThreadDetail({
  thread,
  onDelete,
  onReply,
  onForward,
  onMarkAsRead,
}: ThreadDetailProps) {
  // Track which messages are expanded - latest is expanded by default
  const [expandedIds, setExpandedIds] = useState<Set<string>>(new Set());

  if (!thread) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Mail className="w-12 h-12 mb-4 opacity-20" />
        <p className="text-sm">Select a conversation to view details</p>
      </div>
    );
  }

  const latestMessage = thread.latestMessage;
  const isInbound = latestMessage.direction === "inbound";

  const toggleExpanded = (messageId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(messageId)) {
        next.delete(messageId);
      } else {
        next.add(messageId);
      }
      return next;
    });
  };

  // Expand all / collapse all
  const expandAll = () => {
    setExpandedIds(new Set(thread.messages.map((m) => m.id)));
  };

  const collapseAll = () => {
    setExpandedIds(new Set([latestMessage.id]));
  };

  // Initialize with latest message expanded
  const isMessageExpanded = (messageId: string) => {
    if (expandedIds.size === 0) {
      return messageId === latestMessage.id;
    }
    return expandedIds.has(messageId);
  };

  return (
    <div className="flex flex-col h-full">
      {/* Thread Header */}
      <div className="p-4 border-b space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold truncate">{thread.subject}</h2>
            <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1 text-sm text-muted-foreground">
              <MessageSquare className="w-4 h-4 shrink-0" />
              <span>{thread.messageCount} message{thread.messageCount > 1 ? "s" : ""}</span>
              <span>•</span>
              <span>
                Last activity{" "}
                {format(new Date(latestMessage.created_at), "MMM d, yyyy 'at' h:mm a")}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2">
            {thread.messageCount > 1 && (
              <>
                <Button variant="ghost" size="sm" onClick={expandAll}>
                  Expand all
                </Button>
                <Button variant="ghost" size="sm" onClick={collapseAll}>
                  Collapse
                </Button>
              </>
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this conversation?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This will delete all {thread.messageCount} message
                    {thread.messageCount > 1 ? "s" : ""} in this conversation. This action
                    cannot be undone.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => {
                      thread.messages.forEach((m) => onDelete(m.id));
                    }}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete All
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>
      </div>

      {/* Messages */}
      <ScrollArea className="flex-1 p-4 max-lg:[&>[data-radix-scroll-area-viewport]>div]:!block">
        <div className="space-y-3">
          {thread.messages.map((message) => (
            <SingleMessage
              key={message.id}
              message={message}
              isExpanded={isMessageExpanded(message.id)}
              onToggle={() => toggleExpanded(message.id)}
              isLatest={message.id === latestMessage.id}
            />
          ))}
        </div>
      </ScrollArea>

      <Separator />

      {/* Action buttons */}
      <div className="p-4 flex gap-2">
        {/* Reply - to the latest message sender */}
        {isInbound && onReply && (
          <Button
            onClick={() =>
              onReply({
                toEmail: latestMessage.from_email,
                subject: thread.subject,
                originalBody: latestMessage.html_body || latestMessage.body,
                replyToMessageId: latestMessage.id,
              })
            }
            className="flex-1"
          >
            <Reply className="w-4 h-4 me-2" />
            Reply
          </Button>
        )}

        {/* Forward/Resend */}
        {onForward && (
          <Button
            variant={isInbound ? "outline" : "default"}
            onClick={() => {
              const attachmentsList = Array.isArray(latestMessage.attachments)
                ? (latestMessage.attachments as InboundAttachment[])
                    .map((a) => ({
                      name: a.filename,
                      url: a.url || "",
                    }))
                    .filter((a) => a.url)
                : [];

              onForward({
                subject: thread.subject,
                originalBody: latestMessage.html_body || latestMessage.body,
                originalFrom: latestMessage.from_email,
                originalTo: latestMessage.to_email,
                originalDate: format(
                  new Date(latestMessage.created_at),
                  "MMM d, yyyy 'at' h:mm a"
                ),
                attachments: attachmentsList,
              });
            }}
            className="flex-1"
          >
            <Forward className="w-4 h-4 me-2" />
            {isInbound ? "Forward" : "Resend"}
          </Button>
        )}
      </div>
    </div>
  );
}
