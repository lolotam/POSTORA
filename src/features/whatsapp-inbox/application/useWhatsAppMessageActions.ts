import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useWhatsAppInboxApi,
  type GetConversationStateResponse,
  type WhatsAppMessage,
} from "./ports";
import {
  waConversationStateQueryKey,
  waHistoryQueryKey,
  waLatestQueryKey,
} from "./useWhatsAppMessages";

export const HIDDEN_UNDO_MS = 8_000;

function emptyState(): GetConversationStateResponse {
  return { flags: [], pinned: [], mutable: [] };
}

function patchFlag(
  state: GetConversationStateResponse | undefined,
  messageRowId: string,
  patch: { pinned_at?: string | null; hidden_at?: string | null },
  preview?: { preview: string; timestamp: string | null },
): GetConversationStateResponse {
  const current = state ?? emptyState();
  const existing = current.flags.find((flag) => flag.message_row_id === messageRowId);
  const nextFlag = {
    message_row_id: messageRowId,
    pinned_at: patch.pinned_at !== undefined ? patch.pinned_at : existing?.pinned_at ?? null,
    hidden_at: patch.hidden_at !== undefined ? patch.hidden_at : existing?.hidden_at ?? null,
  };
  const flags = [
    ...current.flags.filter((flag) => flag.message_row_id !== messageRowId),
    nextFlag,
  ];
  let pinned = current.pinned.filter((row) => row.message_row_id !== messageRowId);
  if (nextFlag.pinned_at && !nextFlag.hidden_at) {
    pinned = [
      {
        message_row_id: messageRowId,
        preview: preview?.preview
          ?? current.pinned.find((row) => row.message_row_id === messageRowId)?.preview
          ?? "",
        timestamp: preview?.timestamp
          ?? current.pinned.find((row) => row.message_row_id === messageRowId)?.timestamp
          ?? null,
      },
      ...pinned,
    ];
  }
  return { ...current, flags, pinned };
}

export function useWhatsAppMessageActions(socialAccountId: string, conversationId: string | null): {
  pin(message: WhatsAppMessage): void;
  unpin(message: WhatsAppMessage): void;
  hide(message: WhatsAppMessage): void;
  unhide(messageId: string, restorePin?: boolean): void;
  revoke(message: WhatsAppMessage): void;
  isRevoking: boolean;
} {
  const api = useWhatsAppInboxApi();
  const queryClient = useQueryClient();
  const stateKey = waConversationStateQueryKey(socialAccountId, conversationId);
  const latestKey = waLatestQueryKey(socialAccountId, conversationId);
  const historyKey = waHistoryQueryKey(socialAccountId, conversationId);

  const flagMutation = useMutation({
    mutationFn: async (input: {
      message_row_id: string;
      pinned?: boolean;
      hidden?: boolean;
      preview?: { preview: string; timestamp: string | null };
    }) => {
      if (!conversationId) throw new Error("No conversation selected");
      return api.setMessageFlag({
        social_account_id: socialAccountId,
        conversation_id: conversationId,
        message_row_id: input.message_row_id,
        pinned: input.pinned,
        hidden: input.hidden,
      });
    },
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: stateKey });
      const previous = queryClient.getQueryData<GetConversationStateResponse>(stateKey);
      const now = new Date().toISOString();
      queryClient.setQueryData<GetConversationStateResponse>(stateKey, (old) =>
        patchFlag(old, input.message_row_id, {
          pinned_at: input.pinned === true ? now : input.pinned === false ? null : undefined,
          hidden_at: input.hidden === true ? now : input.hidden === false ? null : undefined,
        }, input.preview),
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous) queryClient.setQueryData(stateKey, context.previous);
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: stateKey });
    },
  });

  const revokeMutation = useMutation({
    mutationFn: async (message: WhatsAppMessage) => {
      const result = await api.revokeMessage({
        social_account_id: socialAccountId,
        message_row_id: message.id,
      });
      if (result.error_type) throw new Error(result.error ?? result.error_type);
      return result;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: latestKey });
      void queryClient.invalidateQueries({ queryKey: historyKey });
      void queryClient.invalidateQueries({ queryKey: stateKey });
    },
  });

  return {
    pin: (message) => {
      flagMutation.mutate({
        message_row_id: message.id,
        pinned: true,
        preview: { preview: message.message, timestamp: message.created_time },
      });
    },
    unpin: (message) => {
      flagMutation.mutate({ message_row_id: message.id, pinned: false });
    },
    hide: (message) => {
      flagMutation.mutate({
        message_row_id: message.id,
        hidden: true,
        pinned: message.pinned_at ? false : undefined,
      });
    },
    unhide: (messageId, restorePin = false) => {
      flagMutation.mutate({
        message_row_id: messageId,
        hidden: false,
        pinned: restorePin ? true : undefined,
      });
    },
    revoke: (message) => {
      revokeMutation.mutate(message);
    },
    isRevoking: revokeMutation.isPending,
  };
}
