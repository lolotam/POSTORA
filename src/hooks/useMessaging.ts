import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { useSocialAccounts } from "./useSocialAccounts";

export interface MessagingAccount {
  id: string;
  platform: string;
  platform_user_id: string;
  platform_username: string | null;
  avatar_url: string | null;
  account_metadata?: Record<string, unknown> | null;
}

export interface Conversation {
  id: string;
  participant_name: string;
  participant_id: string;
  last_message: string;
  last_message_time: string;
  last_message_from: string;
  unread_count: number;
  updated_time: string;
}

export interface Message {
  id: string;
  message: string;
  from: { name: string; id: string };
  to: Array<{ name: string; id: string }>;
  created_time: string;
  attachments: Array<{
    mime_type?: string;
    name?: string;
    image_data?: { url: string; width: number; height: number };
    video_data?: { url: string };
    file_url?: string;
  }>;
}

async function callMessagingApi(action: string, body: Record<string, unknown>) {
  // Always try to refresh session first to avoid stale tokens
  let { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    const { data: refreshed } = await supabase.auth.refreshSession();
    session = refreshed.session;
    if (!session?.access_token) throw new Error("Not authenticated");
  }

  const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
  const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
  // Retry on transient edge-runtime errors (cold-start 502/503/504)
  const url = `${supabaseUrl}/functions/v1/messaging-api`;
  const init: RequestInit = {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${session.access_token}`,
      apikey: anonKey,
    },
    body: JSON.stringify({ action, ...body }),
  };

  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      res = await fetch(url, init);
      if (res.status !== 502 && res.status !== 503 && res.status !== 504) break;
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
  }
  if (!res) throw (lastErr instanceof Error ? lastErr : new Error("Network error"));

  const data = await res.json().catch(() => ({ error: res!.statusText }));
  
  // Handle graceful error responses (returned as 200 with error field)
  if (data.error_type) {
    const msg = String(data.error || "");
    const isIgNotProfessional =
      data.error_type === "GRAPH_ERROR" &&
      /not linked to an Instagram account|not professional account/i.test(msg);
    if (!isIgNotProfessional) {
      console.warn("Messaging API:", data.error_type, data.error);
    }
    const err = new Error(msg) as Error & { errorType?: string };
    err.errorType = data.error_type;
    throw err;
  }
  
  if (!res.ok) {
    throw new Error(data.error || `API error ${res.status}`);
  }
  return data;
}

export function useMessagingAccounts() {
  const { data: allAccounts = [], isLoading } = useSocialAccounts();
  const accounts = allAccounts.filter(
    (a) => (a.platform === "facebook" || a.platform === "instagram" || a.platform === "whatsapp") && a.is_active
  ) as MessagingAccount[];
  return { accounts, isLoading };
}

export function useConversations(socialAccountId: string | null, messagingPlatform: string, options?: { silent?: boolean }) {
  return useQuery({
    queryKey: ["messaging-conversations", socialAccountId, messagingPlatform],
    queryFn: async () => {
      if (!socialAccountId) return [];
      try {
        // WhatsApp uses cached conversations from webhook data
        const action = messagingPlatform === "WHATSAPP" ? "whatsapp_list_conversations" : "list_conversations";
        const data = await callMessagingApi(action, {
          social_account_id: socialAccountId,
          messaging_platform: messagingPlatform,
        });
        return (data.conversations || []) as Conversation[];
      } catch (err) {
        if (options?.silent) {
          const msg = err instanceof Error ? err.message : String(err);
          const isIgNotProfessional = /not linked to an Instagram account|not professional account/i.test(msg);
          if (!isIgNotProfessional) {
            console.warn("Messaging conversations fetch failed silently:", err);
          }
          return [];
        }
        throw err;
      }
    },
    enabled: !!socialAccountId,
    refetchInterval: 30000,
    retry: options?.silent ? false : 1,
  });
}

export function useMessages(conversationId: string | null, socialAccountId: string | null, platform?: string) {
  return useQuery({
    queryKey: ["messaging-messages", conversationId],
    queryFn: async () => {
      if (!conversationId || !socialAccountId) return [];
      // WhatsApp messages come from webhooks, not Graph API
      const action = platform === "whatsapp" ? "whatsapp_get_messages" : "get_messages";
      const data = await callMessagingApi(action, {
        social_account_id: socialAccountId,
        conversation_id: conversationId,
      });
      return (data.messages || []) as Message[];
    },
    enabled: !!conversationId && !!socialAccountId,
    refetchInterval: 15000,
  });
}

export function useSendMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { socialAccountId: string; conversationId: string; message: string; platform?: string; recipientPhone?: string }) => {
      // WhatsApp uses a different action and requires recipient phone
      if (params.platform === "whatsapp" && params.recipientPhone) {
        return callMessagingApi("whatsapp_send_message", {
          social_account_id: params.socialAccountId,
          recipient_phone: params.recipientPhone,
          message: params.message,
        });
      }
      return callMessagingApi("send_message", {
        social_account_id: params.socialAccountId,
        conversation_id: params.conversationId,
        message: params.message,
      });
    },
    onSuccess: (_, vars) => {
      qc.invalidateQueries({ queryKey: ["messaging-messages", vars.conversationId] });
      qc.invalidateQueries({ queryKey: ["messaging-conversations"] });
    },
  });
}

export function useWhatsAppSendTemplate() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: {
      socialAccountId: string;
      recipientPhone: string;
      templateName: string;
      templateLanguage?: string;
      templateComponents?: unknown[];
    }) => {
      return callMessagingApi("whatsapp_send_template", {
        social_account_id: params.socialAccountId,
        recipient_phone: params.recipientPhone,
        template_name: params.templateName,
        template_language: params.templateLanguage || "en_US",
        template_components: params.templateComponents || [],
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messaging-conversations"] });
    },
  });
}

export function useSendMedia() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { socialAccountId: string; recipientId: string; mediaUrl: string; mediaType?: string }) => {
      return callMessagingApi("send_media", {
        social_account_id: params.socialAccountId,
        recipient_id: params.recipientId,
        media_url: params.mediaUrl,
        media_type: params.mediaType || "image",
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messaging-messages"] });
    },
  });
}

export function useDeleteMessage() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { socialAccountId: string; messageId: string }) => {
      return callMessagingApi("delete_message", {
        social_account_id: params.socialAccountId,
        message_id: params.messageId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messaging-messages"] });
    },
  });
}

export function useMarkConversationRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { socialAccountId: string; conversationId: string }) => {
      return callMessagingApi("whatsapp_mark_read", {
        social_account_id: params.socialAccountId,
        conversation_id: params.conversationId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["messaging-conversations"] });
    },
  });
}

export function useWhatsAppRegisterPhone() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (params: { socialAccountId: string }) => {
      return callMessagingApi("whatsapp_register_phone", {
        social_account_id: params.socialAccountId,
      });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["social-accounts"] });
    },
  });
}
