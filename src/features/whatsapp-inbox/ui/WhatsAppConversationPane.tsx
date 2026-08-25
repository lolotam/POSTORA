import { useEffect, useRef, type UIEvent } from "react";
import { ArrowLeft, Loader2, MessageCircle } from "lucide-react";
import { AiConversationModeSelect } from "@/components/messaging/AiConversationModeSelect";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { useMessages, type Conversation } from "@/hooks/useMessaging";
import { sortMessagesForDisplay } from "@/lib/messageOrder";
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const scrollFrameRef = useRef<number | null>(null);
  const latestScrollTopRef = useRef(0);
  const { data: messages = [], isLoading } = useMessages(conversation?.id || null, socialAccountId, "whatsapp");

  // Ported verbatim from ConversationDetail, defect included: `messages` is the raw query
  // array, so the 15s refetchInterval hands this effect a new identity every poll and the
  // pane smooth-scrolls to the bottom while the reader is somewhere else. Phase 1 is layout
  // only and deliberately changes no behaviour; Phase 3 replaces this with the near-bottom
  // check in domain/scrollAnchor.ts. Do not patch it here in isolation -- the fix needs the
  // paginated store to know what "already at the bottom" means.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  useEffect(() => {
    onScrollStateChange(false);
  }, [conversation?.id, onScrollStateChange]);

  useEffect(() => () => {
    if (scrollFrameRef.current !== null) cancelAnimationFrame(scrollFrameRef.current);
  }, []);

  const handleScroll = (event: UIEvent<HTMLDivElement>) => {
    latestScrollTopRef.current = event.currentTarget.scrollTop;
    if (scrollFrameRef.current !== null) return;

    scrollFrameRef.current = requestAnimationFrame(() => {
      const scrollTop = latestScrollTopRef.current;
      scrollFrameRef.current = null;
      if (scrollTop > 72) onScrollStateChange(true);
      else if (scrollTop < 24) onScrollStateChange(false);
    });
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

  const sortedMessages = sortMessagesForDisplay(messages, "whatsapp");

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
        data-testid="wa-message-pane"
        onScroll={handleScroll}
        className="min-h-0 flex-1 space-y-3 overflow-y-auto p-4"
      >
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : sortedMessages.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No messages in this conversation</p>
        ) : (
          sortedMessages.map((message) => (
            <WhatsAppMessageBubble
              key={message.id}
              message={message}
              isSent={message.from?.id === pageId}
            />
          ))
        )}
        <div ref={messagesEndRef} />
      </div>

      <WhatsAppComposer conversation={conversation} socialAccountId={socialAccountId} />
    </div>
  );
}
