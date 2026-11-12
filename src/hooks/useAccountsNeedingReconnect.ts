import { useQuery } from "@tanstack/react-query";
import { useAuth } from "@/hooks/useAuth";
import { supabase } from "@/integrations/supabase/client";

export interface AccountNeedingReconnect {
  id: string;
  platform: string;
  platform_username: string | null;
  needs_reauth: boolean;
  last_refresh_error: string | null;
  social_profile_id: string | null;
  connection_mode: string | null;
  is_active: boolean;
}

const COLUMNS =
  "id, platform, platform_username, needs_reauth, last_refresh_error, social_profile_id, connection_mode, is_active";

/**
 * The accounts the dashboard banner must render.
 *
 * Two sets, because a disconnected WhatsApp account is inactive by design: the OAuth platforms
 * stay active and carry needs_reauth, while an Evolution QR account is deactivated the moment
 * its session dies (see _shared/evolutionQrAccount.ts) and is found by platform and connection
 * mode instead. is_active must not be flipped to make it fit the first query: the reconnectable
 * list and the webhook's account lookup both depend on it.
 */
export function useAccountsNeedingReconnect() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["accounts-needing-reauth", user?.id],
    enabled: !!user,
    refetchInterval: 60000, // Check every minute
    queryFn: async () => {
      if (!user) return [];

      const activeQuery = supabase
        .from("social_accounts")
        .select(COLUMNS)
        .eq("user_id", user.id)
        .eq("is_active", true)
        .eq("needs_reauth", true);

      const whatsappQrQuery = supabase
        .from("social_accounts")
        .select(COLUMNS)
        .eq("user_id", user.id)
        .eq("is_active", false)
        .eq("platform", "whatsapp")
        .eq("connection_mode", "evolution_qr")
        .eq("needs_reauth", true);

      const [active, whatsappQr] = await Promise.all([activeQuery, whatsappQrQuery]);
      if (active.error) throw active.error;
      if (whatsappQr.error) throw whatsappQr.error;

      const merged = [...(active.data ?? []), ...(whatsappQr.data ?? [])];
      const seen = new Set<string>();
      return merged.filter((account) => {
        if (seen.has(account.id)) return false;
        seen.add(account.id);
        return true;
      }) as AccountNeedingReconnect[];
    },
  });
}
