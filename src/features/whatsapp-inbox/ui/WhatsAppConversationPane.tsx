import { useEffect, useLayoutEffect, useRef, useState, type UIEvent } from "react";
import { ArrowLeft, Loader2, MessageCircle } from "lucide-react";
import { AiConversationModeSelect } from "@/components/messaging/AiConversationModeSelect";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useWhatsAppWorkspaceContext } from "@/components/whatsapp/WhatsAppWorkspaceProvider";
import { useMarkConversationRead, type Conversation } from "@/hooks/useMessaging";
import { useWhatsAppMessages } from "../application/useWhatsAppMessages";
import { anchorOffsetAfterPrepend, shouldStickToBottom } from "../domain/scrollAnchor";
import { WhatsAppComposer } from "./WhatsAppComposer";
import { WhatsAppMessageBubble } from "./WhatsAppMessageBubble";

interface WhatsAppConversationPaneProps {
  conversation: Conversation | null;
  socialAccountId: string;
  pageId: string;
  onScrollStateChange(scrolledAway: boolean): void;
  onBack?: () => void;
}

export function WhatsAppConversationPane({
  conversation,
  socialAccountId,
  pageId,
  onScrollStateChange,
  onBack,
}: WhatsAppConversationPaneProps): JSX.Element {
  const scrollRef = useRef<HTMLDivElement>(null);
  const topSentinelRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const selectionRef = useRef("");
  const prevIdsRef = useRef<string[]>([]);
  const stickToBottomRef = useRef(true);
  const prependSnapshotRef = useRef<{ height: number; top: number } | null>(null);
  const initialScrolledRef = useRef(false);
  const [newMessageCount, setNewMessageCount] = useState(0);

  const { messages, isLoading, hasOlder, isFetchingOlder, fetchOlder } = useWhatsAppMessages(
    socialAccountId,
    conversation?.id ?? null,
  );
  const markRead = useMarkConversationRead();
  const { activeRole } = useWhatsAppWorkspaceContext();
  const conversationId = conversation?.id;

  useEffect(() => {
    if (!conversationId || !socialAccountId) return;
    // whatsapp_mark_read is agent-min; a viewer 403s on every open. Do not relax the policy.
    if (activeRole === "viewer") return;
    markRead.mutate(
      { socialAccountId, conversationId },
      { onError: () => undefined },
    );
  }, [activeRole, conversationId, markRead, socialAccountId]);

  useEffect(() => {
    onScrollStateChange(false);
  }, [conversation?.id, onScrollStateChange]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    const selection = `${socialAccountId}:${conversation?.id ?? ""}`;
    if (selectionRef.current !== selection) {
      selectionRef.current = selection;
      prevIdsRef.current = [];
      initialScrolledRef.current = false;
      stickToBottomRef.current = true;
      prependSnapshotRef.current = null;
      setNewMessageCount(0);
    }
    if (!el || !conversation || messages.length === 0) return;

    const prevIds = prevIdsRef.current;
    const nextIds = messages.map((message) => message.id);

    if (!initialScrolledRef.current) {
      el.scrollTop = el.scrollHeight;
      initialScrolledRef.current = true;
      prevIdsRef.current = nextIds;
      stickToBottomRef.current = true;
      return;
    }

    const snapshot = prependSnapshotRef.current;
    if (snapshot) {
      el.scrollTop = anchorOffsetAfterPrepend(snapshot.height, el.scrollHeight, snapshot.top);
      prependSnapshotRef.current = null;
    }

    const prevNewest = prevIds[prevIds.length - 1];
    const nextNewest = nextIds[nextIds.length - 1];
    const appended = Boolean(prevNewest && nextNewest && prevNewest !== nextNewest && nextIds.includes(prevNewest));
    if (appended) {
      const prevSet = new Set(prevIds);
      const added = nextIds.filter((id) => !prevSet.has(id)).length;
      if (stickToBottomRef.current) {
        el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
        setNewMessageCount(0);
      } else if (added > 0) {
        setNewMessageCount((count) => count + added);
      }
    }

    prevIdsRef.current = nextIds;
  }, [conversation, messages, socialAccountId]);

  useEffect(() => {
    const root = scrollRef.current;
    const sentinel = topSentinelRef.current;
    if (!root || !sentinel) return;
    const observer = new IntersectionObserver((entries) => {
      if (!entries.some((entry) => entry.isIntersecting)) return;
      if (!hasOlder || isFetchingOlder) return;
      prependSnapshotRef.current = { height: root.scrollHeight, top: root.scrollTop };
      fetchOlder();
    }, { root });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [fetchOlder, hasOlder, isFetchingOlder, conversation?.id]);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    const el = event.currentTarget;
    latestScrollTopRef.current = el.scrollTop;
    stickToBottomRef.current = shouldStickToBottom(el);
    if (scrollFrameRef.current !== null) return;

    scrollFrameRef.current = requestAnimationFrame(() => {
      const scrollTop = latestScrollTopRef.current;
      scrollFrameRef.current = null;
      if (scrollTop > 72) onScrollStateChange(true);
      else if (scrollTop < 24) onScrollStateChange(false);
    });
  };

  const jumpToLatest = () => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    setNewMessageCount(0);
    stickToBottomRef.current = true;
  };

  if (!conversation) {
    return (
      <div
        data-testid="wa-message-pane"
        onScroll={handleScroll}
        className="flex min-h-0 flex-1 flex-col items-center justify-center overflow-y-auto p-8 text-center"
      >
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-2xl bg-primary/10">
          <MessageCircle className="h-8 w-8 text-primary" />
        </div>
        <h3 className="mb-1 text-lg font-semibold">Select a conversation</h3>
        <p className="text-sm text-muted-foreground">Choose a conversation from the list to view messages</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex min-h-0 shrink-0 items-center gap-3 border-b p-4">
        {onBack && (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Back to conversations"
            onClick={onBack}
            className="h-8 w-8 shrink-0 lg:hidden"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <Avatar className="h-8 w-8">
          <AvatarImage src={conversation.participant_avatar || undefined} alt={conversation.participant_name} />
          <AvatarFallback className="bg-primary/10 text-sm font-semibold text-primary">
            {conversation.participant_name?.charAt(0)?.toUpperCase() || "?"}
          </AvatarFallback>
        </Avatar>
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold">{conversation.participant_name}</p>
          <p className="text-xs text-muted-foreground">
            {conversation.unread_count > 0 ? `${conversation.unread_count} unread` : "Active"}
          </p>
        </div>
        <div className="ml-auto">
          <AiConversationModeSelect
            platform="whatsapp"
            conversationId={conversation.assignment_key || conversation.id}
          />
        </div>
      </div>

      <div
        ref={scrollRef}
        data-testid="wa-message-pane"
        onScroll={handleScroll}
        className="relative min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
      >
        <div ref={topSentinelRef} data-testid="wa-history-sentinel" className="h-px w-full" />
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : messages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages in this conversation</p>
        ) : (
          messages.map((message) => (
            <WhatsAppMessageBubble
              key={message.id}
              message={message}
              isSent={message.from?.id === pageId}
            />
          ))
        )}
        {newMessageCount > 0 && (
          <Button
            type="button"
            data-testid="wa-new-messages"
            size="sm"
            className="sticky bottom-4 left-1/2 z-10 -translate-x-1/2 rounded-full shadow-md"
            onClick={jumpToLatest}
          >
            ↓ {newMessageCount} new messages
          </Button>
        )}
      </div>

      <WhatsAppComposer conversation={conversation} socialAccountId={socialAccountId} />
    </div>
  );
}
