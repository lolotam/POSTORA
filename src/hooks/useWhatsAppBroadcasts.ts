import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

export interface WhatsAppBroadcast {
  id: string;
  user_id: string;
  name: string;
  template_name: string;
  template_components: Record<string, unknown> | null;
  status: string;
  recipient_count: number;
  sent_count: number;
  delivered_count: number;
  failed_count: number;
  created_at: string;
  updated_at: string;
}

export interface BroadcastRecipient {
  id: string;
  broadcast_id: string;
  contact_id: string;
  phone_number: string;
  status: string;
  error_message: string | null;
  sent_at: string | null;
  delivered_at: string | null;
  created_at: string;
}

export function useWhatsAppBroadcasts() {
  const queryClient = useQueryClient();
  const queryKey = ["whatsapp-broadcasts"];

  const { data: broadcasts = [], isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_broadcasts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as WhatsAppBroadcast[];
    },
  });

  const createBroadcast = useMutation({
    mutationFn: async (input: {
      name: string;
      template_name: string;
      template_components?: Record<string, unknown>;
      contact_ids: { id: string; phone: string }[];
    }) => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) throw new Error("Not authenticated");

      // Create broadcast
      const { data: broadcast, error } = await supabase
        .from("whatsapp_broadcasts")
        .insert({
          user_id: user.id,
          name: input.name,
          template_name: input.template_name,
          template_components: input.template_components || null,
          recipient_count: input.contact_ids.length,
        })
        .select()
        .single();
      if (error) throw error;

      // Insert recipients
      const recipients = input.contact_ids.map((c) => ({
        broadcast_id: broadcast.id,
        contact_id: c.id,
        phone_number: c.phone,
      }));

      const { error: rErr } = await supabase
        .from("whatsapp_broadcast_recipients")
        .insert(recipients);
      if (rErr) throw rErr;

      return broadcast as WhatsAppBroadcast;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Broadcast created");
    },
    onError: (e: Error) => toast.error("Failed to create broadcast: " + e.message),
  });

  const sendBroadcast = useMutation({
    mutationFn: async (broadcastId: string) => {
      let { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) {
        const { data: refreshed } = await supabase.auth.refreshSession();
        session = refreshed.session;
        if (!session?.access_token) throw new Error("Not authenticated");
      }

      const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
      const anonKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

      const res = await fetch(
        `${supabaseUrl}/functions/v1/whatsapp-broadcast`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session.access_token}`,
            apikey: anonKey,
          },
          body: JSON.stringify({ broadcast_id: broadcastId }),
        }
      );

      const data = await res.json().catch(() => ({ error: res.statusText }));
      if (!res.ok) throw new Error(data.error || "Broadcast failed");
      return data;
    },
    onSuccess: (data) => {
      queryClient.invalidateQueries({ queryKey });
      toast.success(`Broadcast complete: ${data.sent} sent, ${data.failed} failed`);
    },
    onError: (e: Error) => toast.error("Broadcast failed: " + e.message),
  });

  const deleteBroadcast = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("whatsapp_broadcasts")
        .delete()
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey });
      toast.success("Broadcast deleted");
    },
    onError: (e: Error) => toast.error("Delete failed: " + e.message),
  });

  return {
    broadcasts,
    isLoading,
    createBroadcast,
    sendBroadcast,
    deleteBroadcast,
  };
}

export function useWhatsAppBroadcastRecipients(broadcastId: string | null) {
  return useQuery({
    queryKey: ["whatsapp-broadcast-recipients", broadcastId],
    queryFn: async () => {
      if (!broadcastId) return [];
      const { data, error } = await supabase
        .from("whatsapp_broadcast_recipients")
        .select("*")
        .eq("broadcast_id", broadcastId)
        .order("created_at", { ascending: true });
      if (error) throw error;
      return (data || []) as BroadcastRecipient[];
    },
    enabled: !!broadcastId,
  });
}
