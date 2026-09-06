import { useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { ArrowLeft, Loader2, MessageCircle } from "lucide-react";
import { AiConversationModeSelect } from "@/components/messaging/AiConversationModeSelect";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useWhatsAppWorkspaceContext } from "@/components/whatsapp/WhatsAppWorkspaceProvider";
import { useMarkConversationRead, type Conversation } from "@/hooks/useMessaging";
import { HIDDEN_UNDO_MS, useWhatsAppMessageActions } from "../application/useWhatsAppMessageActions";
import { useWhatsAppMessages } from "../application/useWhatsAppMessages";
import type { WhatsAppConnectionMode } from "../domain/whatsappCapabilities";
import { anchorOffsetAfterPrepend, shouldStickToBottom } from "../domain/scrollAnchor";
import { PinnedMessagesBar } from "./PinnedMessagesBar";
import { WhatsAppComposer } from "./WhatsAppComposer";
import { WhatsAppForwardDialog, type ForwardTarget } from "./WhatsAppForwardDialog";
import { WhatsAppMessageBubble } from "./WhatsAppMessageBubble";

interface WhatsAppConversationPaneProps {
  conversation: Conversation | null;
  socialAccountId: string;
  pageId: string;
  connectionMode?: WhatsAppConnectionMode;
  /** Chats and contacts the forward dialog can send to; the screen builds it from the list. */
  forwardTargets?: ForwardTarget[];
  onScrollStateChange(scrolledAway: boolean): void;
  onBack?: () => void;
}

export function WhatsAppConversationPane({
  conversation,
  socialAccountId,
  pageId,
  connectionMode = null,
  forwardTargets = [],
  onScrollStateChange,
  onBack,
}: WhatsAppConversationPaneProps): JSX.Element {
  const [forwardRowId, setForwardRowId] = useState<string | null>(null);
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

  const { messages, pinned, isLoading, hasOlder, isFetchingOlder, fetchOlder } = useWhatsAppMessages(
    socialAccountId,
    conversation?.id ?? null,
  );
  const actions = useWhatsAppMessageActions(socialAccountId, conversation?.id ?? null);
  const visibleMessages = useMemo(
    () => messages.filter((message) => !message.hidden_at),
    [messages],
  );
  const [hiddenUndo, setHiddenUndo] = useState<{ id: string; wasPinned: boolean } | null>(null);
  const undoTimerRef = useRef<number | null>(null);
  // Only `mutate` goes into the effect below. useMutation's result object is rebuilt on every
  // render, and listing it as a dependency re-armed the effect after each mutate: an infinite
  // mark-read loop that took production down on 2026-08-26 (~100 requests/s per open tab, and
  // every conversations query invalidated on each cycle until Meta rate-limited the app).
  const { mutate: markConversationRead } = useMarkConversationRead();
  const { activeRole } = useWhatsAppWorkspaceContext();
  const conversationId = conversation?.id;

  useEffect(() => {
    if (!conversationId || !socialAccountId) return;
    // whatsapp_mark_read is agent-min; a viewer 403s on every open. Do not relax the policy.
    if (activeRole === "viewer") return;
    markConversationRead(
      { socialAccountId, conversationId },
      { onError: () => undefined },
    );
  }, [activeRole, conversationId, markConversationRead, socialAccountId]);

  useEffect(() => {
    onScrollStateChange(false);
  }, [conversation?.id, onScrollStateChange]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
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
      setHiddenUndo(null);
    }
    if (!el || !conversation || visibleMessages.length === 0) return;

    const prevIds = prevIdsRef.current;
    const nextIds = visibleMessages.map((message) => message.id);

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
  }, [conversation, socialAccountId, visibleMessages]);

  // Opening a chat must LAND at the newest message, not travel to it.
  //
  // Pinning scrollTop once is not enough: at that moment the images are still 96px
  // placeholders, and each one grows to a few hundred px as it decodes. The document
  // therefore gets taller *after* the pin, which pushes the newest message back down out of
  // view -- the reader is left somewhere in old history, and the next append animates all the
  // way down. That is the "starts at the beginning and races to the end" the user sees.
  //
  // So re-pin on every size change for as long as the reader is meant to be at the bottom,
  // and do it by assignment rather than scrollTo({behavior:"smooth"}) so it never reads as
  // travel. Once they scroll up, stickToBottomRef goes false and this stops touching them.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!stickToBottomRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);
    return () => observer.disconnect();
  }, [conversation?.id, socialAccountId]);

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

  const scheduleUndo = (id: string, wasPinned: boolean) => {
    setHiddenUndo({ id, wasPinned });
    if (undoTimerRef.current !== null) window.clearTimeout(undoTimerRef.current);
    undoTimerRef.current = window.setTimeout(() => {
      undoTimerRef.current = null;
      setHiddenUndo(null);
    }, HIDDEN_UNDO_MS);
  };

  const hideMessage = (message: (typeof messages)[number]) => {
    actions.hide(message);
    scheduleUndo(message.id, Boolean(message.pinned_at));
  };

  const undoHide = () => {
    if (!hiddenUndo) return;
    actions.unhide(hiddenUndo.id, hiddenUndo.wasPinned);
    setHiddenUndo(null);
    if (undoTimerRef.current !== null) {
      window.clearTimeout(undoTimerRef.current);
      undoTimerRef.current = null;
    }
  };

  const scrollToMessage = (messageRowId: string) => {
    const node = scrollRef.current?.querySelector(`[data-message-id="${messageRowId}"]`);
    node?.scrollIntoView({ block: "center" });
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

      <PinnedMessagesBar
        pinned={pinned}
        loadedIds={new Set(visibleMessages.map((message) => message.id))}
        onScrollTo={scrollToMessage}
      />

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
        ) : visibleMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages in this conversation</p>
        ) : (
          visibleMessages.map((message) => (
            <WhatsAppMessageBubble
              key={message.id}
              message={message}
              isSent={message.from?.id === pageId}
              connectionMode={connectionMode}
              onForward={() => setForwardRowId(message.id)}
              onPin={() => actions.pin(message)}
              onUnpin={() => actions.unpin(message)}
              onHide={() => hideMessage(message)}
              onRevoke={() => actions.revoke(message)}
            />
          ))
        )}
        {hiddenUndo ? (
          <div
            data-testid="wa-hidden-undo"
            className="sticky bottom-4 z-10 flex items-center justify-center gap-2 rounded-full bg-foreground px-3 py-1.5 text-xs text-background shadow-md"
          >
            1 message hidden —
            <button type="button" className="font-semibold underline" onClick={undoHide}>
              Undo
            </button>
          </div>
        ) : null}
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

      <WhatsAppComposer
        conversation={conversation}
        socialAccountId={socialAccountId}
        connectionMode={connectionMode}
      />

      <WhatsAppForwardDialog
        open={forwardRowId !== null}
        onOpenChange={(open) => !open && setForwardRowId(null)}
        socialAccountId={socialAccountId}
        messageRowId={forwardRowId}
        targets={forwardTargets}
      />
    </div>
  );
}
