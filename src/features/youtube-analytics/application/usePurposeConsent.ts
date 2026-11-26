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

  const accept = useMutation({
    mutationFn: async (connectionRevision: string) => {
      if (!accountId) throw new Error("No channel selected");
      return gateway.acceptConsent({
        accountId,
        purposeVersion: ANALYTICS_PURPOSE_VERSION,
        locale,
        connectionRevision,
      });
    },
    onSuccess: onAccepted,
  });

  const withdraw = useMutation({
    mutationFn: async () => {
      if (!accountId) throw new Error("No channel selected");
      return gateway.withdrawConsent({ accountId, locale });
    },
    onSuccess: () => {
      onWithdrawn();
      if (accountId) {
        setTimeout(() => {
          queryClient.removeQueries({
            predicate: (query) => isAccountAnalyticsQueryKey(query.queryKey, userId, accountId),
          });
        }, 0);
      }
    },
  });

  return {
    accept: accept.mutateAsync,
    withdraw: withdraw.mutateAsync,
    accepting: accept.isPending,
    withdrawing: withdraw.isPending,
    acceptError: accept.error,
    withdrawError: withdraw.error,
  };
}
