import { useEffect, useId, useRef } from "react";
import { useQueryClient, type QueryKey } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

type AccountEvent = {
  user_id?: string;
  social_account_id?: string;
};

export function matchesRealtimeAccountEvent(
  event: AccountEvent,
  userId: string | undefined,
  socialAccountId: string | null,
) {
  return event.user_id === userId && event.social_account_id === socialAccountId;
}

export function realtimeChannelName(
  table: string,
  socialAccountId: string,
  subscriptionId: string,
) {
  return `realtime:${table}:${socialAccountId}:${subscriptionId}`;
}

export function useRealtimeQueryInvalidation({
  table,
  userId,
  socialAccountId,
  queryKey,
}: {
  table: string;
  userId: string | undefined;
  socialAccountId: string | null;
  queryKey: QueryKey;
}) {
  const queryClient = useQueryClient();
  const subscriptionId = useId();
  const queryKeyRef = useRef(queryKey);
  queryKeyRef.current = queryKey;

  useEffect(() => {
    if (!userId || !socialAccountId) return;

    const channel = supabase
      .channel(realtimeChannelName(table, socialAccountId, subscriptionId))
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table, filter: `user_id=eq.${userId}` },
        (payload) => {
          const event = (payload.new ?? payload.old) as AccountEvent;
          if (matchesRealtimeAccountEvent(event, userId, socialAccountId)) {
            queryClient.invalidateQueries({ queryKey: queryKeyRef.current });
          }
        },
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient, socialAccountId, subscriptionId, table, userId]);
}
