import { useState, useMemo, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { useAdminInbox, InboxMessage } from "@/hooks/useAdminInbox";
import { supabase } from "@/integrations/supabase/client";
import { ThreadedMessageList, groupMessagesIntoThreads, type MessageThread } from "./ThreadedMessageList";
import { ThreadDetail } from "./ThreadDetail";
import { ComposeEmail, type ComposeEmailRef, type DraftData } from "./ComposeEmail";
import { ScheduledEmailsManager } from "./ScheduledEmailsManager";
import { DraftsManager, type EmailDraft } from "./DraftsManager";
import { TestEmailButton } from "./TestEmailButton";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { ArrowLeft, PanelLeftClose, PanelLeftOpen, Loader2, RefreshCw, CheckCheck, Mail, Clock, ArrowDownLeft, ArrowUpRight, Inbox, Search, X, FileEdit, RotateCcw, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";

type MessageFilter = "all" | "received" | "sent";

export function AdminInbox() {
  const {
    messages,
    unreadCount,
    isLoading,
    isRefetching,
    error,
    markAsRead,
    markAllAsRead,
    deleteMessage,
    deleteMessages,
    isDeletingMessages,
    syncDeliveryStatuses,
    isSyncingDeliveryStatuses,
    refetch,
  } = useAdminInbox();

  const composeRef = useRef<ComposeEmailRef>(null);
  const [selectedThread, setSelectedThread] = useState<MessageThread | null>(null);
  const [activeTab, setActiveTab] = useState("inbox");
  const [messageFilter, setMessageFilter] = useState<MessageFilter>("all");
  const [searchQuery, setSearchQuery] = useState("");
  // Collapsing the thread rail is a reading-mode choice, not navigation, so it
  // is deliberately per-mount rather than persisted.
  const [threadsCollapsed, setThreadsCollapsed] = useState(false);
  const [selectedThreadIds, setSelectedThreadIds] = useState<Set<string>>(new Set());

  // Fetch draft count
  const { data: draftCount = 0 } = useQuery({
    queryKey: ["email-drafts-count"],
    queryFn: async () => {
      const { count, error } = await supabase
        .from("email_drafts")
        .select("*", { count: "exact", head: true });

      if (error) throw error;
      return count || 0;
    },
  });

  // Filter messages based on direction and search query
  const filteredMessages = useMemo(() => {
    let filtered = messages;
    
    // Apply direction filter
    if (messageFilter === "received") filtered = filtered.filter(m => m.direction === "inbound");
    if (messageFilter === "sent") filtered = filtered.filter(m => m.direction === "outbound");
    
    // Apply search filter
    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter(m => 
        m.from_email.toLowerCase().includes(query) ||
        m.to_email.toLowerCase().includes(query) ||
        (m.subject?.toLowerCase().includes(query)) ||
        (m.body?.toLowerCase().includes(query))
      );
    }
    
    return filtered;
  }, [messages, messageFilter, searchQuery]);

  const handleSelectThread = (thread: MessageThread) => {
    setSelectedThread(thread);
    // Mark all unread inbound messages in thread as read
    thread.messages.forEach((message) => {
      if (!message.is_read && message.direction === "inbound") {
        markAsRead(message.id);
      }
    });
  };

  const handleThreadDeleted = () => {
    setSelectedThread(null);
  };

  // Map thread id -> all message ids in that thread (from full message set, so
  // selected threads that get filtered out of view still resolve on delete).
  const threadMessageMap = useMemo(() => {
    const allThreads = groupMessagesIntoThreads(messages);
    const map = new Map<string, string[]>();
    allThreads.forEach((t) => map.set(t.id, t.messages.map((m) => m.id)));
    return map;
  }, [messages]);

  const handleToggleThread = useCallback((threadId: string) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (next.has(threadId)) next.delete(threadId);
      else next.add(threadId);
      return next;
    });
  }, []);

  const handleToggleAll = useCallback((threadIds: string[], select: boolean) => {
    setSelectedThreadIds((prev) => {
      const next = new Set(prev);
      if (select) threadIds.forEach((id) => next.add(id));
      else threadIds.forEach((id) => next.delete(id));
      return next;
    });
  }, []);

  const handleBulkDelete = () => {
    const ids: string[] = [];
    selectedThreadIds.forEach((tid) => {
      const msgIds = threadMessageMap.get(tid);
      if (msgIds) ids.push(...msgIds);
    });
    const wasSelectedThreadDeleted = selectedThread
      ? selectedThreadIds.has(selectedThread.id)
      : false;
    deleteMessages(ids);
    setSelectedThreadIds(new Set());
    if (wasSelectedThreadDeleted) handleThreadDeleted();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-[600px]">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex flex-col items-center justify-center h-[600px] gap-4">
        <p className="text-destructive">Error loading messages: {error}</p>
        <Button onClick={() => refetch()} variant="outline">
          <RefreshCw className="w-4 h-4 me-2" />
          Retry
        </Button>
      </div>
    );
  }

  return (
    <Tabs value={activeTab} onValueChange={setActiveTab} className="flex flex-col h-full space-y-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <TabsList>
          <TabsTrigger value="inbox" className="gap-2">
            <Mail className="w-4 h-4" />
            Inbox
            {unreadCount > 0 && (
              <span className="ms-1 px-1.5 py-0.5 text-xs font-medium bg-primary text-primary-foreground rounded-full">
                {unreadCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="drafts" className="gap-2">
            <FileEdit className="w-4 h-4" />
            Drafts
            {draftCount > 0 && (
              <span className="ms-1 px-1.5 py-0.5 text-xs font-medium bg-amber-500 text-white rounded-full">
                {draftCount}
              </span>
            )}
          </TabsTrigger>
          <TabsTrigger value="scheduled" className="gap-2">
            <Clock className="w-4 h-4" />
            Scheduled
          </TabsTrigger>
        </TabsList>
        
        {activeTab === "inbox" && (
          <div className="flex flex-wrap items-center gap-2">
            {selectedThreadIds.size > 0 && (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="destructive" size="sm">
                    <Trash2 className="w-4 h-4 me-2" />
                    Delete {selectedThreadIds.size}
                  </Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>
                      Delete {selectedThreadIds.size} conversation{selectedThreadIds.size > 1 ? "s" : ""}?
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                      This will permanently delete all messages in the selected conversation{selectedThreadIds.size > 1 ? "s" : ""}. This action cannot be undone.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={handleBulkDelete}
                      className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      disabled={isDeletingMessages}
                    >
                      {isDeletingMessages ? "Deleting..." : "Delete All"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}
            {/* Message Filter */}
            <Select value={messageFilter} onValueChange={(v) => setMessageFilter(v as MessageFilter)}>
              <SelectTrigger className="w-auto min-w-[150px] h-9 whitespace-nowrap">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">
                  <div className="flex items-center gap-2">
                    <Inbox className="h-4 w-4" />
                    All Messages
                  </div>
                </SelectItem>
                <SelectItem value="received">
                  <div className="flex items-center gap-2">
                    <ArrowDownLeft className="h-4 w-4 text-blue-500" />
                    Received
                  </div>
                </SelectItem>
                <SelectItem value="sent">
                  <div className="flex items-center gap-2">
                    <ArrowUpRight className="h-4 w-4 text-green-500" />
                    Sent
                  </div>
                </SelectItem>
              </SelectContent>
            </Select>
            
            <TestEmailButton />
            <ComposeEmail ref={composeRef} />
            <Button
              variant="outline"
              size="sm"
              onClick={() => syncDeliveryStatuses()}
              disabled={isSyncingDeliveryStatuses}
            >
              <RotateCcw className={cn("w-4 h-4 me-2", isSyncingDeliveryStatuses && "animate-spin")} />
              {isSyncingDeliveryStatuses ? "Syncing..." : "Sync status"}
            </Button>
            {unreadCount > 0 && (
              <Button variant="outline" size="sm" onClick={markAllAsRead}>
                <CheckCheck className="w-4 h-4 me-2" />
                Mark all read
              </Button>
            )}
            <Button 
              variant="outline" 
              size="sm" 
              onClick={() => refetch()}
              disabled={isRefetching}
            >
              <RefreshCw className={cn("w-4 h-4 me-2", isRefetching && "animate-spin")} />
              {isRefetching ? "Refreshing..." : "Refresh"}
            </Button>
          </div>
        )}
      </div>

      {/* `flex` outranks the [hidden] Radix sets on an inactive tab, so on
          phones the empty inbox pane would push Drafts/Scheduled down. */}
      <TabsContent value="inbox" className="mt-0 flex-1 min-h-0 flex flex-col gap-4 max-md:data-[state=inactive]:hidden">
        {/* Search Bar */}
        <div className="flex items-center gap-2 shrink-0">
          <Button
            variant="outline"
            size="icon"
            className="shrink-0 max-md:hidden"
            onClick={() => setThreadsCollapsed((collapsed) => !collapsed)}
            aria-label={threadsCollapsed ? "Show conversation list" : "Hide conversation list"}
            title={threadsCollapsed ? "Show conversation list" : "Hide conversation list"}
          >
            {threadsCollapsed ? (
              <PanelLeftOpen className="h-4 w-4 rtl-flip" />
            ) : (
              <PanelLeftClose className="h-4 w-4 rtl-flip" />
            )}
          </Button>
          <div className="relative flex-1 min-w-0">
          <Search className="absolute start-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search by sender, subject, or content..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="ps-9 pe-9"
          />
          {searchQuery && (
            <Button
              variant="ghost"
              size="sm"
              className="absolute end-1 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
              onClick={() => setSearchQuery("")}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
          </div>
        </div>

        {/* flex-1 + min-h-0 instead of a viewport calc: the panels now grow to
            the bottom of <main>, and the old h-[calc(100vh-340px)] guessed at a
            chrome height that changes whenever the toolbar above wraps. */}
        {/* Below md only one pane fits: the list until a thread is picked,
            then the thread with a Back button that clears the selection. */}
        <div className="flex gap-4 flex-1 min-h-0">
          <div
            className={cn(
              "border rounded-lg overflow-hidden bg-card transition-[width] duration-200 shrink-0",
              threadsCollapsed ? "w-0 border-0 opacity-0 pointer-events-none" : "w-full md:w-1/3 md:min-w-[300px]",
              selectedThread && "max-md:hidden"
            )}
          >
            <ThreadedMessageList
              messages={filteredMessages}
              selectedThreadId={selectedThread?.id}
              onSelectThread={handleSelectThread}
              selectedThreadIds={selectedThreadIds}
              onToggleThread={handleToggleThread}
              onToggleAll={handleToggleAll}
            />
          </div>
          {/* min-w-0 so a long subject line cannot push the rail off screen. */}
          <div
            className={cn(
              "flex-1 min-w-0 border rounded-lg overflow-hidden bg-card",
              !selectedThread && "max-md:hidden",
              selectedThread && "max-md:flex max-md:flex-col"
            )}
          >
            {selectedThread && (
              <div className="md:hidden shrink-0 border-b p-2">
                <Button variant="ghost" size="sm" onClick={() => setSelectedThread(null)}>
                  <ArrowLeft className="w-4 h-4 me-2 rtl-flip" />
                  Back
                </Button>
              </div>
            )}
            <div className="h-full max-md:h-auto max-md:flex-1 max-md:min-h-0">
              <ThreadDetail
                thread={selectedThread}
                onDelete={(id) => {
                  deleteMessage(id);
                  // Check if this was the last message in the thread
                  if (selectedThread && selectedThread.messages.length <= 1) {
                    handleThreadDeleted();
                  }
                }}
                onReply={(data) => composeRef.current?.openReply(data)}
                onForward={(data) => composeRef.current?.openForward(data)}
                onMarkAsRead={markAsRead}
              />
            </div>
          </div>
        </div>
      </TabsContent>

      <TabsContent value="drafts" className="mt-0">
        <DraftsManager 
          onEditDraft={(draft: EmailDraft) => {
            const draftData: DraftData = {
              id: draft.id,
              fromEmail: draft.from_email,
              toEmails: draft.to_emails || [],
              ccEmails: draft.cc_emails || [],
              bccEmails: draft.bcc_emails || [],
              subject: draft.subject,
              body: draft.body,
              htmlBody: draft.html_body,
              attachments: draft.attachments || null,
              replyToMessageId: draft.reply_to_message_id,
            };
            // Switch to inbox tab first so the ComposeEmail component is rendered
            setActiveTab("inbox");
            // Use setTimeout to ensure tab switch completes before opening draft
            setTimeout(() => {
              composeRef.current?.openDraft(draftData);
            }, 50);
          }}
        />
      </TabsContent>

      <TabsContent value="scheduled" className="mt-0">
        <ScheduledEmailsManager />
      </TabsContent>
    </Tabs>
  );
}
