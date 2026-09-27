import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";

export const SCHEDULED_CANCEL_BLOCKED = "This message is already being sent and can no longer be cancelled.";

export const SCHEDULED_OWN_ACCOUNT_ONLY = "You can only schedule from your own WhatsApp accounts.";

/** Same shape `whatsapp-scheduled-sender` accepts: optional +, then digits and separators only. */
const RECIPIENT_PHONE_FORMAT = /^\+?[0-9][0-9\s\-().]*$/;

export const WHATSAPP_MESSAGE_MAX = 4096;

export interface OwnWhatsAppAccount {
  id: string;
  platform_username: string | null;
  platform_user_id: string;
  connection_mode: string | null;
}

export interface ScheduleMessageInput {
  socialAccountId: string;
  recipientPhone: string;
  recipientName?: string;
  messageText?: string;
  mediaUrl?: string;
  mediaType?: string;
  scheduledAt: string;
}

/** Digits only, or null when the sender would refuse the number. */
export function recipientDigits(raw: string): string | null {
  const trimmed = raw.trim();
  if (!RECIPIENT_PHONE_FORMAT.test(trimmed)) return null;
  const digits = trimmed.replace(/\D/g, "");
  if (digits.length < 8 || digits.length > 15) return null;
  return digits;
}

export function isHttpsUrl(raw: string): boolean {
  try {
    return new URL(raw.trim()).protocol === "https:";
  } catch {
    return false;
  }
}

/** Local datetime-local value as UTC ISO, or null when it is under a minute ahead. */
export function scheduledAtFromLocal(localValue: string, now = Date.now()): string | null {
  if (!localValue) return null;
  const when = new Date(localValue);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() < now + 60_000) return null;
  return when.toISOString();
}

function scheduleFailure(error: { code?: string; message?: string } | null): Error {
  if (error?.code === "42501") return new Error(SCHEDULED_OWN_ACCOUNT_ONLY);
  return new Error(error?.message || "Could not schedule the message");
}

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

  const accountsQuery = useQuery({
    queryKey: ["whatsapp-own-accounts", userId],
    queryFn: async () => {
      if (!userId) return [];
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, platform_user_id, connection_mode")
        .eq("user_id", userId)
        .eq("platform", "whatsapp")
        .eq("is_active", true)
        .order("platform_username", { ascending: true });
      if (error) throw error;
      return (data || []) as OwnWhatsAppAccount[];
    },
    enabled: !!userId,
  });

  const schedule = useMutation({
    mutationFn: async (params: ScheduleMessageInput) => {
      if (!userId) throw new Error(SCHEDULED_OWN_ACCOUNT_ONLY);
      const recipientPhone = params.recipientPhone.replace(/\D/g, "");
      const { data, error } = await supabase
        .from("whatsapp_scheduled_messages")
        .insert({
          user_id: userId,
          social_account_id: params.socialAccountId,
          recipient_phone: recipientPhone,
          recipient_name: params.recipientName?.trim() || null,
          message_text: params.messageText?.trim() || null,
          media_url: params.mediaUrl?.trim() || null,
          media_type: params.mediaType?.trim() || null,
          scheduled_at: params.scheduledAt,
          status: "pending",
        })
        .select("id")
        .single();
      if (error || !data) throw scheduleFailure(error);
      return data;
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
    accounts: accountsQuery.data || [],
    accountsLoading: accountsQuery.isLoading,
    accountsError: accountsQuery.isError,
    schedule,
    cancel,
  };
}
