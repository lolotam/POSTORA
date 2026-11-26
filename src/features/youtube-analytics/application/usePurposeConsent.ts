import { useRef } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { YouTubeAnalyticsGateway } from "./ports";
import { isAccountAnalyticsQueryKey } from "./queryKeys";
import { ANALYTICS_PURPOSE_VERSION } from "../domain/types";

export function usePurposeConsent(params: {
  gateway: YouTubeAnalyticsGateway;
  userId: string;
  accountId: string | null;
  locale: "en" | "ar";
  onAccepted: () => void | Promise<unknown>;
  onWithdrawn: () => void;
}) {
  const { gateway, userId, accountId, locale, onAccepted, onWithdrawn } = params;
  const queryClient = useQueryClient();
  const latestSelectionRef = useRef({ userId, accountId });
  latestSelectionRef.current = { userId, accountId };

  const accept = useMutation({
    mutationFn: async (variables: { targetUserId: string; targetAccountId: string; connectionRevision: string }) => {
      return gateway.acceptConsent({
        accountId: variables.targetAccountId,
        purposeVersion: ANALYTICS_PURPOSE_VERSION,
        locale,
        connectionRevision: variables.connectionRevision,
      });
    },
    onSuccess: (_data, variables) => {
      if (latestSelectionRef.current.userId === variables.targetUserId
        && latestSelectionRef.current.accountId === variables.targetAccountId) {
        return onAccepted();
      }
    },
  });

  const withdraw = useMutation({
    mutationFn: async (variables: { targetUserId: string; targetAccountId: string }) => {
      return gateway.withdrawConsent({ accountId: variables.targetAccountId, locale });
    },
    onSuccess: (_data, variables) => {
      if (latestSelectionRef.current.userId === variables.targetUserId
        && latestSelectionRef.current.accountId === variables.targetAccountId) {
        onWithdrawn();
      }
      setTimeout(() => {
        queryClient.removeQueries({
          predicate: (query) => isAccountAnalyticsQueryKey(query.queryKey, variables.targetUserId, variables.targetAccountId),
        });
      }, 0);
    },
  });

  return {
    accept: (connectionRevision: string) => {
      if (!accountId) return Promise.reject(new Error("No channel selected"));
      return accept.mutateAsync({ targetUserId: userId, targetAccountId: accountId, connectionRevision });
    },
    withdraw: () => {
      if (!accountId) return Promise.reject(new Error("No channel selected"));
      return withdraw.mutateAsync({ targetUserId: userId, targetAccountId: accountId });
    },
    accepting: accept.isPending,
    withdrawing: withdraw.isPending,
    acceptError: accept.error,
    withdrawError: withdraw.error,
  };
}
