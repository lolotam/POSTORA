import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useEffect, useCallback } from "react";
import { toast } from "sonner";

export interface InboxMessage {
  id: string;
  from_email: string;
  to_email: string;
  subject: string | null;
  body: string | null;
  html_body: string | null;
  direction: string;
  status: string;
  is_read: boolean;
  admin_id: string | null;
  resend_id: string | null;
  reply_to_id: string | null;
  thread_id: string | null;
  message_type: string;
  attachments: unknown;
  metadata: unknown;
  created_at: string;
  updated_at: string;
}

export function useAdminInbox() {
  const queryClient = useQueryClient();

  // Fetch messages with auto-refresh every 10 seconds
  const {
    data: messages = [],
    isLoading,
    isFetching: isRefetching,
    error,
    refetch,
  } = useQuery({
    queryKey: ["admin-inbox-messages"],
    queryFn: async (): Promise<InboxMessage[]> => {
      const { data, error } = await supabase
        .from("admin_inbox_messages")
        .select("*")
        .order("created_at", { ascending: false })
        .limit(100);

      if (error) throw error;
      return data || [];
    },
    refetchInterval: 10000, // Auto-refresh every 10 seconds
  });

  // Calculate unread count
  const unreadCount = messages.filter((m) => !m.is_read && m.direction === "inbound").length;

  // Mark message as read
  const markAsReadMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("admin_inbox_messages")
        .update({ is_read: true })
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
    },
  });

  // Mark all as read
  const markAllAsReadMutation = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from("admin_inbox_messages")
        .update({ is_read: true })
        .eq("is_read", false)
        .eq("direction", "inbound");

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      toast.success("All messages marked as read");
    },
  });

  // Delete message
  const deleteMessageMutation = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("admin_inbox_messages")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      toast.success("Message deleted");
    },
  });

  // Bulk delete messages (by thread)
  const deleteMessagesMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      if (ids.length === 0) return;
      const { error } = await supabase
        .from("admin_inbox_messages")
        .delete()
        .in("id", ids);

      if (error) throw error;
    },
    onSuccess: (_data, ids) => {
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      toast.success(
        `Deleted ${ids.length} message${ids.length === 1 ? "" : "s"}`
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to delete messages");
    },
  });

  // Fallback: Sync delivery statuses directly from Resend (useful if webhooks aren't configured)
  const syncDeliveryStatusesMutation = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase.functions.invoke(
        "sync-resend-delivery-status",
        { body: { limit: 50 } }
      );
      if (error) throw error;
      return data as { checked: number; updated: number; errors: number };
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
      toast.success(
        `Synced delivery statuses (updated ${data?.updated ?? 0}/${data?.checked ?? 0})`
      );
    },
    onError: (err) => {
      toast.error(err instanceof Error ? err.message : "Failed to sync delivery statuses");
    },
  });

  // Subscribe to real-time updates
  useEffect(() => {
    const channel = supabase
      .channel("admin-inbox-changes")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "admin_inbox_messages",
        },
        (payload) => {
          console.log("Inbox realtime update:", payload);
          
          if (payload.eventType === "INSERT") {
            const newMessage = payload.new as InboxMessage;
            if (newMessage.direction === "inbound") {
              // Show notification for new inbound messages
              toast.info(`New email from ${newMessage.from_email}`, {
                description: newMessage.subject || "No subject",
              });
            }
          }
          
          if (payload.eventType === "UPDATE") {
            const updatedMessage = payload.new as InboxMessage;
            const oldMessage = payload.old as Partial<InboxMessage>;
            
            // Only notify on status changes for outbound emails
            if (updatedMessage.direction === "outbound" && oldMessage.status !== updatedMessage.status) {
              const statusMessages: Record<string, { message: string; type: "success" | "error" | "info" }> = {
                delivered: { message: `Email to ${updatedMessage.to_email} was delivered ✓`, type: "success" },
                bounced: { message: `Email to ${updatedMessage.to_email} bounced ✗`, type: "error" },
                complaint: { message: `Email to ${updatedMessage.to_email} marked as spam`, type: "error" },
              };
              
              const statusInfo = statusMessages[updatedMessage.status];
              if (statusInfo) {
                if (statusInfo.type === "success") {
                  toast.success(statusInfo.message);
                } else if (statusInfo.type === "error") {
                  toast.error(statusInfo.message);
                } else {
                  toast.info(statusInfo.message);
                }
              }
            }
          }
          
          // Refetch messages on any change
          queryClient.invalidateQueries({ queryKey: ["admin-inbox-messages"] });
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);

  const markAsRead = useCallback(
    (id: string) => markAsReadMutation.mutate(id),
    [markAsReadMutation]
  );

  const markAllAsRead = useCallback(
    () => markAllAsReadMutation.mutate(),
    [markAllAsReadMutation]
  );

  const deleteMessage = useCallback(
    (id: string) => deleteMessageMutation.mutate(id),
    [deleteMessageMutation]
  );

  const deleteMessages = useCallback(
    (ids: string[]) => deleteMessagesMutation.mutate(ids),
    [deleteMessagesMutation]
  );

  const syncDeliveryStatuses = useCallback(
    () => syncDeliveryStatusesMutation.mutate(),
    [syncDeliveryStatusesMutation]
  );

  return {
    messages,
    unreadCount,
    isLoading,
    isRefetching,
    error: error?.message,
    markAsRead,
    markAllAsRead,
    deleteMessage,
    deleteMessages,
    isDeletingMessages: deleteMessagesMutation.isPending,
    syncDeliveryStatuses,
    isSyncingDeliveryStatuses: syncDeliveryStatusesMutation.isPending,
    refetch,
  };
}
