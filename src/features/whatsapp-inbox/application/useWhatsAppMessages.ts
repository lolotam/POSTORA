import { useCallback, useEffect, useRef, useState } from "react";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { sortMessagesForDisplay } from "@/lib/messageOrder";
import {
  mergeMessagesIntoStore,
  oldestMessageCursor,
  type MessageCursor,
} from "../domain/messageCursor";
import { useWhatsAppInboxApi, type WhatsAppMessage } from "./ports";

export const WA_LATEST_REFETCH_MS = 15_000;
export const WA_HISTORY_PAGE_SIZE = 40;

function tagConversation(messages: WhatsAppMessage[], conversationId: string): WhatsAppMessage[] {
  return messages.map((message) => (
    message.conversation_id ? message : { ...message, conversation_id: conversationId }
  ));
}

export function useWhatsAppMessages(socialAccountId: string, conversationId: string | null): {
  messages: WhatsAppMessage[];
  isLoading: boolean;
  hasOlder: boolean;
  isFetchingOlder: boolean;
  fetchOlder(): void;
} {
  const api = useWhatsAppInboxApi();
  const selectionKey = `${socialAccountId}::${conversationId ?? ""}`;
  const storeRef = useRef(new Map<string, WhatsAppMessage>());
  const selectionRef = useRef(selectionKey);
  const [messages, setMessages] = useState<WhatsAppMessage[]>([]);
  const [loadOlder, setLoadOlder] = useState(false);

  if (selectionRef.current !== selectionKey) {
    selectionRef.current = selectionKey;
    storeRef.current = new Map();
    setMessages([]);
    setLoadOlder(false);
  }

  const latestQuery = useQuery({
    queryKey: ["wa-latest", socialAccountId, conversationId],
    queryFn: () => api.getMessagesPage({
      social_account_id: socialAccountId,
      conversation_id: conversationId as string,
    }),
    enabled: Boolean(socialAccountId && conversationId),
    refetchInterval: WA_LATEST_REFETCH_MS,
  });

  const historyQuery = useInfiniteQuery({
    queryKey: ["wa-history", socialAccountId, conversationId],
    queryFn: async ({ pageParam }: { pageParam: MessageCursor | undefined }) => {
      const before = pageParam ?? oldestMessageCursor([...storeRef.current.values()]);
      if (!before || !conversationId) {
        return { messages: [] as WhatsAppMessage[], page_info: { next_before: null, has_more: false } };
      }
      return api.getMessagesPage({
        social_account_id: socialAccountId,
        conversation_id: conversationId,
        limit: WA_HISTORY_PAGE_SIZE,
        before,
      });
    },
    initialPageParam: undefined as MessageCursor | undefined,
    getNextPageParam: (last) => last.page_info?.next_before ?? undefined,
    refetchInterval: false,
    enabled: Boolean(socialAccountId && conversationId && loadOlder),
  });

  useEffect(() => {
    if (selectionRef.current !== selectionKey) return;
    if (!conversationId) {
      setMessages([]);
      return;
    }

    let changed = false;
    if (latestQuery.data?.messages) {
      changed = mergeMessagesIntoStore(
        storeRef.current,
        tagConversation(latestQuery.data.messages, conversationId),
      ) || changed;
    }
    for (const page of historyQuery.data?.pages ?? []) {
      changed = mergeMessagesIntoStore(
        storeRef.current,
        tagConversation(page.messages ?? [], conversationId),
      ) || changed;
    }
    if (!changed && messages.length === storeRef.current.size) return;
    setMessages(sortMessagesForDisplay([...storeRef.current.values()], "whatsapp"));
  }, [conversationId, historyQuery.data, latestQuery.data, messages.length, selectionKey]);

  const historyFetched = (historyQuery.data?.pages.length ?? 0) > 0;
  const hasOlder = Boolean(conversationId) && (
    historyFetched
      ? Boolean(historyQuery.hasNextPage)
      : messages.length >= 100
  );

  const isFetchingOlder = historyQuery.isFetchingNextPage || (loadOlder && historyQuery.isFetching);
  const isLoading = Boolean(conversationId) && latestQuery.isLoading && messages.length === 0;

  const fetchNextPage = historyQuery.fetchNextPage;
  const fetchOlder = useCallback(() => {
    if (!hasOlder || isFetchingOlder) return;
    if (storeRef.current.size === 0) return;
    if (!loadOlder) {
      setLoadOlder(true);
      return;
    }
    void fetchNextPage();
  }, [fetchNextPage, hasOlder, isFetchingOlder, loadOlder]);

  return { messages, isLoading, hasOlder, isFetchingOlder, fetchOlder };
}
