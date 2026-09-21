import { useState } from "react";
import { InboxMessage } from "@/hooks/useAdminInbox";
import { sanitizeEmailHtml } from "@/lib/sanitizeHtml";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
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
import { ArrowDownLeft, ArrowUpRight, Trash2, Mail, Paperclip, Download, FileText, Image as ImageIcon, File, RefreshCw, Loader2, Reply, Forward } from "lucide-react";
import { cn } from "@/lib/utils";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import type { ReplyData, ForwardData } from "./ComposeEmail";
import { DeliveryStatusBadge } from "./DeliveryStatusBadge";

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

interface MessageDetailProps {
  message: InboxMessage | null;
  onDelete: (id: string) => void;
  onReply?: (data: ReplyData) => void;
  onForward?: (data: ForwardData) => void;
}

export function MessageDetail({ message, onDelete, onReply, onForward }: MessageDetailProps) {
  const [isFetchingContent, setIsFetchingContent] = useState(false);
  const queryClient = useQueryClient();

  const handleFetchContent = async () => {
    if (!message) return;
    
    setIsFetchingContent(true);
    try {
      const { data, error } = await supabase.functions.invoke("fetch-email-content", {
        body: { messageId: message.id },
      });

      if (error) {
        console.error("Failed to fetch content:", error);
        toast.error("Failed to fetch email content");
        return;
      }

      console.log("Fetch result:", data);
      
      if (data.success) {
        toast.success(
          `Fetched: ${data.fetched.bodyLength} chars body, ${data.fetched.attachments} attachments`
        );
        // Refresh the inbox messages
        queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      } else {
        toast.error("Failed to fetch content from Resend");
      }
    } catch (error) {
      console.error("Error fetching content:", error);
      toast.error("Failed to fetch email content");
    } finally {
      setIsFetchingContent(false);
    }
  };

  // Check if message is missing content
  const isMissingContent = message && 
    message.direction === "inbound" && 
    !message.body && 
    !message.html_body;

  if (!message) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
        <Mail className="w-12 h-12 mb-4 opacity-20" />
        <p className="text-sm">Select a message to view details</p>
      </div>
    );
  }

  const isInbound = message.direction === "inbound";

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="p-4 border-b space-y-3">
        <div className="flex items-start justify-between gap-4">
          <div className="flex-1 min-w-0">
            <h2 className="text-lg font-semibold truncate">
              {message.subject || "(No subject)"}
            </h2>
            <div className="flex items-center gap-2 mt-1 text-sm text-muted-foreground">
              <span
                className={cn(
                  "p-1 rounded-full",
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
              </span>
              <span>
                {isInbound ? "From" : "To"}: <strong>{isInbound ? message.from_email : message.to_email}</strong>
              </span>
              <span>•</span>
              <span>{format(new Date(message.created_at), "MMM d, yyyy 'at' h:mm a")}</span>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Status Badge */}
            <Badge
              variant="outline"
              className={cn(
                message.status === "received" && "border-blue-500 text-blue-500",
                message.status === "sent" && "border-green-500 text-green-500",
                message.status === "delivered" && "border-green-500 text-green-500",
                message.status === "replied" && "border-green-500 text-green-500",
                message.status === "bounced" && "border-red-500 text-red-500",
                message.status === "complaint" && "border-orange-500 text-orange-500"
              )}
            >
              {message.status}
            </Badge>

            {/* Delivery Status for outbound */}
            {message.direction === "outbound" && message.status !== "delivered" && (
              <DeliveryStatusBadge 
                status={message.status} 
                direction={message.direction}
                metadata={message.metadata as { open_count?: number; first_opened_at?: string; click_count?: number; first_clicked_at?: string } | null}
                showLabel
              />
            )}

            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="icon" className="text-muted-foreground hover:text-destructive">
                  <Trash2 className="w-4 h-4" />
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this message?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This action cannot be undone. The message will be permanently deleted.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction
                    onClick={() => onDelete(message.id)}
                    className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                  >
                    Delete
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        </div>

        {/* To/From details */}
        <div className="text-sm text-muted-foreground">
          {isInbound ? (
            <p>To: {message.to_email}</p>
          ) : (
            <p>From: {message.from_email}</p>
          )}
        </div>

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
                const Icon = getAttachmentIcon(attachment.content_type || "application/octet-stream");
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
      </div>

      {/* Body */}
      <ScrollArea className="flex-1 p-4">
        {isMissingContent ? (
          <div className="flex flex-col items-center justify-center h-full py-8 text-muted-foreground">
            <Mail className="w-10 h-10 mb-3 opacity-30" />
            <p className="text-sm mb-4">Email content not available</p>
            <Button 
              onClick={handleFetchContent} 
              disabled={isFetchingContent}
              variant="outline"
              size="sm"
            >
              {isFetchingContent ? (
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
              ) : (
                <RefreshCw className="w-4 h-4 me-2" />
              )}
              {isFetchingContent ? "Fetching..." : "Fetch content from Resend"}
            </Button>
          </div>
        ) : message.html_body ? (
          <div
            className="prose prose-sm dark:prose-invert max-w-none"
            dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(message.html_body) }}
          />
        ) : (
          <pre className="text-sm whitespace-pre-wrap font-sans">
            {message.body || "No content"}
          </pre>
        )}
      </ScrollArea>

      <Separator />

      {/* Action buttons */}
      <div className="p-4 flex gap-2">
        {/* Reply - only for inbound */}
        {isInbound && onReply && (
          <Button 
            onClick={() => onReply({
              toEmail: message.from_email,
              subject: message.subject || "(no subject)",
              originalBody: message.html_body || message.body,
              replyToMessageId: message.id,
            })} 
            className="flex-1"
          >
            <Reply className="w-4 h-4 me-2" />
            Reply
          </Button>
        )}
        
        {/* Forward/Resend - for all messages */}
        {onForward && (
          <Button 
            variant={isInbound ? "outline" : "default"}
            onClick={() => {
              const attachmentsList = Array.isArray(message.attachments) 
                ? (message.attachments as InboundAttachment[]).map(a => ({
                    name: a.filename,
                    url: a.url || "",
                  })).filter(a => a.url)
                : [];
              
              onForward({
                subject: message.subject || "(no subject)",
                originalBody: message.html_body || message.body,
                originalFrom: message.from_email,
                originalTo: message.to_email,
                originalDate: format(new Date(message.created_at), "MMM d, yyyy 'at' h:mm a"),
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
