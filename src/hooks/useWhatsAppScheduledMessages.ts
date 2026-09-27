import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export const SCHEDULED_CANCEL_BLOCKED = "This message is already being sent and can no longer be cancelled.";

export interface ScheduledMessage {
  id: string;
  social_account_id: string;
  recipient_phone: string;
  recipient_name: string | null;
  message_text: string | null;
  media_url: string | null;
  media_type: string | null;
  scheduled_at: string;
  status: string;
  sent_at: string | null;
  error_message: string | null;
  created_at: string;
}

export function useWhatsAppScheduledMessages(socialAccountId?: string) {
  const { session } = useAuth();
  const userId = session?.user?.id;
  const qc = useQueryClient();

  const query = useQuery({
    queryKey: ["whatsapp-scheduled", userId, socialAccountId],
    queryFn: async () => {
      if (!userId) return [];
      let q = supabase.from("whatsapp_scheduled_messages").select("*").eq("user_id", userId).order("scheduled_at", { ascending: true });
      if (socialAccountId) q = q.eq("social_account_id", socialAccountId);
      const { data, error } = await q;
      if (error) throw error;
      return (data || []) as ScheduledMessage[];
    },
    enabled: !!userId,
  });

  const schedule = useMutation({
    mutationFn: async (params: {
      socialAccountId: string;
      recipientPhone: string;
      recipientName?: string;
      messageText?: string;
      mediaUrl?: string;
      mediaType?: string;
      scheduledAt: string;
    }) => {
      const { error } = await supabase.from("whatsapp_scheduled_messages").insert({
        user_id: userId!,
        social_account_id: params.socialAccountId,
        recipient_phone: params.recipientPhone,
        recipient_name: params.recipientName || null,
        message_text: params.messageText || null,
        media_url: params.mediaUrl || null,
        media_type: params.mediaType || null,
        scheduled_at: params.scheduledAt,
        status: "pending",
      });
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-scheduled"] }),
  });

  const cancel = useMutation({
    mutationFn: async (id: string) => {
      const { data, error } = await supabase
        .from("whatsapp_scheduled_messages")
        .update({ status: "cancelled" })
        .eq("id", id)
        .eq("status", "pending")
        .select("id");
      if (error) throw error;
      if (!data || data.length === 0) {
        throw new Error(SCHEDULED_CANCEL_BLOCKED);
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["whatsapp-scheduled"] }),
  });

  return {
    messages: query.data || [],
    isLoading: query.isLoading,
    schedule,
    cancel,
  };
}
