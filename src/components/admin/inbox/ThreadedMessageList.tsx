import { useMemo, useState } from "react";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Checkbox } from "@/components/ui/checkbox";
import { InboxMessage } from "@/hooks/useAdminInbox";
import { cn } from "@/lib/utils";
import { format } from "date-fns";
import { ArrowDownLeft, ArrowUpRight, Paperclip, MessageSquare, ChevronRight } from "lucide-react";
import { DeliveryStatusBadge } from "./DeliveryStatusBadge";

export interface MessageThread {
  id: string; // thread_id or message id if standalone
  subject: string;
  messages: InboxMessage[];
  latestMessage: InboxMessage;
  hasUnread: boolean;
  messageCount: number;
}

function groupMessagesIntoThreads(messages: InboxMessage[]): MessageThread[] {
  const threadMap = new Map<string, InboxMessage[]>();
  const standaloneMessages: InboxMessage[] = [];

  // Group messages by thread_id or treat as standalone
  messages.forEach((message) => {
    if (message.thread_id) {
      const existing = threadMap.get(message.thread_id) || [];
      existing.push(message);
      threadMap.set(message.thread_id, existing);
    } else if (message.reply_to_id) {
      // Try to find parent message's thread
      const parentThread = Array.from(threadMap.entries()).find(([_, msgs]) =>
        msgs.some((m) => m.id === message.reply_to_id)
      );
      if (parentThread) {
        parentThread[1].push(message);
      } else {
        // Create new implicit thread
        const implicitThreadId = `implicit-${message.reply_to_id}`;
        const existing = threadMap.get(implicitThreadId) || [];
        existing.push(message);
        threadMap.set(implicitThreadId, existing);
      }
    } else {
      standaloneMessages.push(message);
    }
  });

  // Convert to thread objects
  const threads: MessageThread[] = [];

  threadMap.forEach((threadMessages, threadId) => {
    // Sort by date ascending within thread
    threadMessages.sort(
      (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    );

    const latestMessage = threadMessages[threadMessages.length - 1];
    const firstMessage = threadMessages[0];

    threads.push({
      id: threadId,
      subject: firstMessage.subject || "(No subject)",
      messages: threadMessages,
      latestMessage,
      hasUnread: threadMessages.some((m) => !m.is_read && m.direction === "inbound"),
      messageCount: threadMessages.length,
    });
  });

  // Add standalone messages as single-message threads
  standaloneMessages.forEach((message) => {
    threads.push({
      id: message.id,
      subject: message.subject || "(No subject)",
      messages: [message],
      latestMessage: message,
      hasUnread: !message.is_read && message.direction === "inbound",
      messageCount: 1,
    });
  });

  // Sort threads by latest message date
  threads.sort(
    (a, b) =>
      new Date(b.latestMessage.created_at).getTime() -
      new Date(a.latestMessage.created_at).getTime()
  );

  return threads;
}

interface ThreadedMessageListProps {
  messages: InboxMessage[];
  selectedThreadId?: string;
  onSelectThread: (thread: MessageThread) => void;
  selectedThreadIds?: Set<string>;
  onToggleThread?: (threadId: string) => void;
  onToggleAll?: (threadIds: string[], select: boolean) => void;
}

export function ThreadedMessageList({
  messages,
  selectedThreadId,
  onSelectThread,
  selectedThreadIds,
  onToggleThread,
  onToggleAll,
}: ThreadedMessageListProps) {
  const threads = useMemo(() => groupMessagesIntoThreads(messages), [messages]);

  const visibleSelectedCount = threads.filter((t) => selectedThreadIds?.has(t.id)).length;
  const allSelected = threads.length > 0 && visibleSelectedCount === threads.length;
  const someSelected = visibleSelectedCount > 0;

  if (threads.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full text-muted-foreground p-4">
        <p className="text-sm">No messages yet</p>
        <p className="text-xs mt-1">Inbound emails will appear here</p>
      </div>
    );
  }

  return (
    // Radix wraps content in a display:table div that grows to its widest row,
    // which defeats `truncate` below lg where the list pane is narrow or full-width.
    <ScrollArea className="h-full max-lg:[&>[data-radix-scroll-area-viewport]>div]:!block">
      {onToggleAll && threads.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/30 sticky top-0 z-10">
          <Checkbox
            checked={allSelected}
            onCheckedChange={() => onToggleAll(threads.map((t) => t.id), !allSelected)}
            aria-label="Select all visible conversations"
          />
          <span className="text-xs text-muted-foreground select-none">
            {someSelected && !allSelected
              ? `${visibleSelectedCount} of ${threads.length} selected`
              : allSelected
                ? `All ${threads.length} selected`
                : "Select all"}
          </span>
        </div>
      )}
      <div className="divide-y">
        {threads.map((thread) => {
          const latest = thread.latestMessage;
          const isSelected = selectedThreadId === thread.id;
          const isChecked = selectedThreadIds?.has(thread.id) ?? false;

          return (
            <div
              key={thread.id}
              className={cn(
                "flex items-stretch transition-colors",
                isSelected && "bg-muted",
                thread.hasUnread && "bg-primary/5",
                isChecked && !isSelected && "bg-primary/10"
              )}
            >
              {onToggleThread && (
                <div
                  className="flex items-center ps-3 cursor-pointer flex-shrink-0"
                  onClick={(e) => e.stopPropagation()}
                >
                  <Checkbox
                    checked={isChecked}
                    onCheckedChange={() => onToggleThread(thread.id)}
                    aria-label={`Select conversation: ${thread.subject}`}
                  />
                </div>
              )}
              <button
                onClick={() => onSelectThread(thread)}
                className="flex-1 min-w-0 text-start p-4 hover:bg-muted/50 transition-colors"
              >
                <div className="flex items-start gap-3">
                  {/* Direction indicator */}
                  <div
                    className={cn(
                      "mt-1 p-1 rounded-full",
                      latest.direction === "inbound"
                        ? "bg-blue-500/10 text-blue-500"
                        : "bg-green-500/10 text-green-500"
                    )}
                  >
                    {latest.direction === "inbound" ? (
                      <ArrowDownLeft className="w-3 h-3" />
                    ) : (
                      <ArrowUpRight className="w-3 h-3" />
                    )}
                  </div>

                  <div className="flex-1 min-w-0">
                    {/* From/To and Unread indicator */}
                    <div className="flex items-center gap-2">
                      {thread.hasUnread && (
                        <span className="w-2 h-2 rounded-full bg-primary flex-shrink-0" />
                      )}
                      <span
                        className={cn(
                          "text-sm truncate flex-1",
                          thread.hasUnread ? "font-semibold" : "font-medium"
                        )}
                      >
                        {latest.direction === "inbound"
                          ? latest.from_email
                          : `To: ${latest.to_email}`}
                      </span>
                      {/* Thread count badge */}
                      {thread.messageCount > 1 && (
                        <span className="flex items-center gap-1 px-1.5 py-0.5 text-xs font-medium bg-muted rounded-full text-muted-foreground">
                          <MessageSquare className="w-3 h-3" />
                          {thread.messageCount}
                        </span>
                      )}
                      {/* Delivery status for outbound */}
                      {latest.direction === "outbound" && (
                        <DeliveryStatusBadge
                          status={latest.status}
                          direction={latest.direction}
                          metadata={
                            latest.metadata as {
                              open_count?: number;
                              first_opened_at?: string;
                              click_count?: number;
                              first_clicked_at?: string;
                            } | null
                          }
                        />
                      )}
                    </div>

                    {/* Subject */}
                    <p
                      className={cn(
                        "text-sm truncate mt-0.5",
                        thread.hasUnread ? "text-foreground" : "text-muted-foreground"
                      )}
                    >
                      {thread.subject}
                    </p>

                    {/* Preview and Meta */}
                    <div className="flex items-center justify-between mt-1 gap-2">
                      <p className="text-xs text-muted-foreground truncate flex-1">
                        {latest.body?.substring(0, 60) || "No content"}
                        {(latest.body?.length || 0) > 60 && "..."}
                      </p>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {Array.isArray(latest.attachments) &&
                          latest.attachments.length > 0 && (
                            <Paperclip className="w-3 h-3 text-muted-foreground" />
                          )}
                        <span className="text-xs text-muted-foreground">
                          {format(new Date(latest.created_at), "MMM d")}
                        </span>
                      </div>
                    </div>
                  </div>

                  {/* Chevron for threads */}
                  {thread.messageCount > 1 && (
                    <ChevronRight className="w-4 h-4 text-muted-foreground mt-1" />
                  )}
                </div>
              </button>
            </div>
          );
        })}
      </div>
    </ScrollArea>
  );
}

export { groupMessagesIntoThreads };
