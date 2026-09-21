import { ScrollArea } from "@/components/ui/scroll-area";
import { InboxMessage } from "@/hooks/useAdminInbox";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ArrowDownLeft, ArrowUpRight, Paperclip } from "lucide-react";
import { DeliveryStatusBadge } from "./DeliveryStatusBadge";

interface MessageListProps {
  messages: InboxMessage[];
  selectedId?: string;
  onSelect: (message: InboxMessage) => void;
}

export function MessageList({ messages, selectedId, onSelect }: MessageListProps) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-sm">No messages yet</p>
        <p className="text-xs mt-1">Inbound emails will appear here</p>
      </div>
    );
  }

  return (
    <ScrollArea className="h-full">
      <div className="divide-y">
        {messages.map((message) => (
          <button
            key={message.id}
            onClick={() => onSelect(message)}
            className={cn(
              "w-full text-start p-4 hover:bg-muted/50 transition-colors",
              selectedId === message.id && "bg-muted",
              !message.is_read && message.direction === "inbound" && "bg-primary/5"
            )}
          >
            <div className="flex items-start gap-3">
              {/* Direction indicator */}
              <div
                className={cn(
                  "mt-1 p-1 rounded-full",
                  message.direction === "inbound"
                    ? "bg-blue-500/10 text-blue-500"
                    : "bg-green-500/10 text-green-500"
                )}
              >
                {message.direction === "inbound" ? (
                  <ArrowDownLeft className="w-3 h-3" />
                ) : (
                  <ArrowUpRight className="w-3 h-3" />
                )}
              </div>

              <div className="flex-1 min-w-0">
                {/* From/To and Unread indicator */}
                <div className="flex items-center gap-2">
                  {!message.is_read && message.direction === "inbound" && (
                    <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                  )}
                  <span
                    className={cn(
                      "text-sm truncate flex-1",
                      !message.is_read && message.direction === "inbound"
                        ? "font-semibold"
                        : "font-medium"
                    )}
                  >
                    {message.direction === "inbound"
                      ? message.from_email
                      : `To: ${message.to_email}`}
                  </span>
                  {/* Delivery status for outbound */}
                  {message.direction === "outbound" && (
                    <DeliveryStatusBadge 
                      status={message.status} 
                      direction={message.direction}
                      metadata={message.metadata as { open_count?: number; first_opened_at?: string; click_count?: number; first_clicked_at?: string } | null}
                    />
                  )}
                </div>

                {/* Subject */}
                <p
                  className={cn(
                    "text-sm truncate mt-0.5",
                    !message.is_read && message.direction === "inbound"
                      ? "text-foreground"
                      : "text-muted-foreground"
                  )}
                >
                  {message.subject || "(No subject)"}
                </p>

                {/* Preview and Meta */}
                <div className="flex items-center justify-between mt-1 gap-2">
                  <p className="text-xs text-muted-foreground truncate flex-1">
                    {message.body?.substring(0, 60) || "No content"}
                    {(message.body?.length || 0) > 60 && "..."}
                  </p>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    {Array.isArray(message.attachments) && message.attachments.length > 0 && (
                      <Paperclip className="w-3 h-3 text-muted-foreground" />
                    )}
                    <span className="text-xs text-muted-foreground">
                      {format(new Date(message.created_at), "MMM d")}
                    </span>
                  </div>
                </div>

                {/* Status badge for inbound replied */}
                {message.direction === "inbound" && message.status === "replied" && (
                  <DeliveryStatusBadge 
                    status={message.status} 
                    direction={message.direction}
                    showLabel
                    className="mt-1"
                  />
                )}
              </div>
            </div>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
