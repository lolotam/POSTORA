import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";
import type { ReconnectableWhatsAppAccount } from "@/hooks/useReconnectableWhatsApp";

/**
 * Direct QR accounts that were disconnected and can be restored in place: the same
 * social_accounts row, the same AI agent setup, a fresh QR scan. Unlike the Meta
 * modes, a QR session can only come back by pairing the same phone again, which is
 * what the bridge's reconnect_qr action drives.
 */
export function useReconnectableQrAccounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["whatsapp-reconnectable-qr", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_user_id, platform_username, connection_mode, updated_at")
        .eq("platform", "whatsapp")
        .eq("connection_mode", "evolution_qr")
        .eq("is_active", false)
        .not("platform_user_id", "like", "pending_%")
        .not("platform_user_id", "like", "retired_%")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []) as ReconnectableWhatsAppAccount[];
    },
  });
}
