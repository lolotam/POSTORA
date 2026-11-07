import { useEffect, useId, useRef } from "react";
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

/** How often the list is refreshed while a broadcast is sending. */
const BROADCAST_POLL_MS = 4_000;
/**
 * A broadcast nobody touched for this long is not going to finish. The worker would have
 * failed it as stalled by now, so the poll stops instead of asking forever.
 */
const BROADCAST_STALE_MS = 20 * 60 * 1000;
const EMPTY_BROADCASTS: WhatsAppBroadcast[] = [];
/** Stable so the realtime effect does not resubscribe on every render. */
const BROADCASTS_QUERY_KEY = ["whatsapp-broadcasts"];

export function useWhatsAppBroadcasts() {
  const queryClient = useQueryClient();
  const queryKey = BROADCASTS_QUERY_KEY;
  const subscriptionId = useId();

  /** Broadcasts this tab is waiting for. */
  const trackedRef = useRef<Set<string>>(new Set());
  /** Broadcasts whose final toast was already shown. */
  const toastedRef = useRef<Set<string>>(new Set());
  /** The last counts and status seen per broadcast, to spot a change. */
  const snapshotRef = useRef<Map<string, string>>(new Map());

  const { data: broadcasts = EMPTY_BROADCASTS, isLoading } = useQuery({
    queryKey,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("whatsapp_broadcasts")
        .select("*")
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data || []) as WhatsAppBroadcast[];
    },
    refetchInterval: (query) => {
      const rows = (query.state.data ?? []) as WhatsAppBroadcast[];
      const sending = rows.filter((broadcast) => broadcast.status === "sending");
      if (sending.length === 0) return false;
      const stale = sending.every(
        (broadcast) => Date.now() - new Date(broadcast.updated_at).getTime() > BROADCAST_STALE_MS,
      );
      return stale ? false : BROADCAST_POLL_MS;
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
          template_components: (input.template_components as never) || null,
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
    onSuccess: (_data, broadcastId) => {
      // The broadcast is tracked before the list is invalidated: a broadcast that finishes
      // before the first refetch still has to toast its result exactly once.
      trackedRef.current.add(broadcastId);
      toast.success("Broadcast submitted — sending in the background");
      queryClient.invalidateQueries({ queryKey });
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

  // The final toast and the recipient refresh. Both read the same fresh rows.
  useEffect(() => {
    for (const broadcast of broadcasts) {
      const snapshot = [
        broadcast.status,
        broadcast.sent_count,
        broadcast.failed_count,
        broadcast.delivered_count,
      ].join(":");
      const previous = snapshotRef.current.get(broadcast.id);
      const firstTrackedTerminal = previous === undefined && trackedRef.current.has(broadcast.id) &&
        (broadcast.status === "completed" || broadcast.status === "failed");
      if ((previous !== undefined && previous !== snapshot) || firstTrackedTerminal) {
        queryClient.invalidateQueries({ queryKey: ["whatsapp-broadcast-recipients", broadcast.id] });
      }
      snapshotRef.current.set(broadcast.id, snapshot);

      if (broadcast.status === "sending") trackedRef.current.add(broadcast.id);
      if (broadcast.status !== "completed" && broadcast.status !== "failed") continue;
      if (!trackedRef.current.has(broadcast.id)) continue;
      if (toastedRef.current.has(broadcast.id)) continue;

      toastedRef.current.add(broadcast.id);
      trackedRef.current.delete(broadcast.id);
      if (broadcast.status === "completed") {
        toast.success(
          `Broadcast complete: ${broadcast.sent_count} sent, ${broadcast.failed_count} failed`,
        );
      } else {
        toast.error(`Broadcast failed: ${broadcast.failed_count} failed`);
      }
    }
  }, [broadcasts, queryClient]);

  // One subscription per hook instance. A shared topic throws on the second `.on()`.
  useEffect(() => {
    let active = true;
    let channel: ReturnType<typeof supabase.channel> | null = null;

    void supabase.auth.getUser()
      .then(({ data: { user } }) => {
        if (!active || !user) return;
        channel = supabase
          .channel(`whatsapp-broadcasts-${user.id}-${subscriptionId}`)
          .on(
            "postgres_changes",
            {
              event: "UPDATE",
              schema: "public",
              table: "whatsapp_broadcasts",
              filter: `user_id=eq.${user.id}`,
            },
            (payload) => {
              const changed = payload as { new?: { id?: string } };
              const id = changed.new?.id;
              if (id) {
                queryClient.invalidateQueries({ queryKey: ["whatsapp-broadcast-recipients", id] });
              }
              queryClient.invalidateQueries({ queryKey: BROADCASTS_QUERY_KEY });
            },
          )
          .subscribe();
      })
      .catch((error: unknown) => {
        console.error("[whatsapp-broadcasts] realtime subscription failed", error);
      });

    return () => {
      active = false;
      if (channel) void supabase.removeChannel(channel);
    };
  }, [queryClient, subscriptionId]);

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
