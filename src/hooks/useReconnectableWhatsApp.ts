import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export interface ReconnectableWhatsAppAccount {
  id: string;
  platform_user_id: string;
  platform_username: string | null;
  connection_mode: string | null;
  updated_at: string;
}

/**
 * Meta-hosted WhatsApp accounts that were disconnected in-product and can be
 * restored by resubscribing.
 *
 * useSocialAccounts filters on is_active, so a disconnected account disappears
 * from every surface in the app. For a coexistence number that is still live and
 * healthy at Meta, that left no way back: Embedded Signup only offers numbers
 * available to *onboard*, so an already-onboarded number never appears there
 * either. Direct QR accounts are excluded because a logged-out Baileys session
 * genuinely cannot be restored without scanning a new code.
 */
export function useReconnectableWhatsApp() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["whatsapp-reconnectable", user?.id],
    enabled: !!user,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, platform_user_id, platform_username, connection_mode, updated_at")
        .eq("platform", "whatsapp")
        .eq("is_active", false)
        .in("connection_mode", ["coexistence", "cloud_api"])
        // A placeholder id means the account never finished connecting, so there
        // is nothing at Meta to resubscribe to.
        .not("platform_user_id", "like", "pending_%")
        .not("platform_user_id", "like", "retired_%")
        .order("updated_at", { ascending: false });
      if (error) throw error;
      return (data || []) as ReconnectableWhatsAppAccount[];
    },
  });
}
