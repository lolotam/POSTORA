import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface WhatsAppWebhook {
  id: string;
  user_id: string;
  name: string;
  url: string;
  secret: string | null;
  events: string[];
  is_active: boolean;
  last_triggered_at: string | null;
  last_status_code: number | null;
  failure_count: number;
  created_at: string;
  updated_at: string;
}

export function useWhatsAppWebhooks() {
  const queryClient = useQueryClient();

  const { data: webhooks = [], isLoading } = useQuery({
    queryKey: ["whatsapp-webhooks"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_webhooks")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as WhatsAppWebhook[];
    },
  });

  const createWebhook = useMutation({
    mutationFn: async (webhook: { name: string; url: string; secret?: string; events?: string[] }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");
      const { error } = await supabase.from("whatsapp_webhooks").insert({
        user_id: user.id,
        name: webhook.name,
        url: webhook.url,
        secret: webhook.secret || null,
        events: webhook.events || ["message.received"],
      });
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-webhooks"] });
      toast.success("Webhook created");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const updateWebhook = useMutation({
    mutationFn: async ({ id, ...updates }: Partial<WhatsAppWebhook> & { id: string }) => {
      const { error } = await supabase.from("whatsapp_webhooks").update(updates).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-webhooks"] });
      toast.success("Webhook updated");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const deleteWebhook = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from("whatsapp_webhooks").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["whatsapp-webhooks"] });
      toast.success("Webhook deleted");
    },
    onError: (e: Error) => toast.error(e.message),
  });

  const testWebhook = useMutation({
    mutationFn: async (webhook: WhatsAppWebhook) => {
      const payload = {
        event: "message.received",
        timestamp: new Date().toISOString(),
        test: true,
        data: {
          from: "+1234567890",
          contact_name: "Test Contact",
          message: "This is a test message from Postora",
          message_type: "text",
          conversation_id: "wa_test_conversation",
          phone_number_id: "test_phone_id",
        },
      };

      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (webhook.secret) {
        const encoder = new TextEncoder();
        const key = await crypto.subtle.importKey("raw", encoder.encode(webhook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
        const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(JSON.stringify(payload)));
        headers["X-Webhook-Signature"] = Array.from(new Uint8Array(sig)).map(b => b.toString(16).padStart(2, "0")).join("");
      }

      const res = await fetch(webhook.url, { method: "POST", headers, body: JSON.stringify(payload) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return res.status;
    },
    onSuccess: (status) => toast.success(`Test successful (HTTP ${status})`),
    onError: (e: Error) => toast.error(`Test failed: ${e.message}`),
  });

  return { webhooks, isLoading, createWebhook, updateWebhook, deleteWebhook, testWebhook };
}
