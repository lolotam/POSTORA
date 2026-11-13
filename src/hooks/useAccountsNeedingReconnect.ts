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

/** Which of the two queries failed. */
export type ReconnectCheckScope = "active" | "whatsapp_qr";

export interface AccountsNeedingReconnectResult {
  /** Every account the banner must render. */
  accounts: AccountNeedingReconnect[];
  /**
   * Set when exactly one of the two queries failed. The other half is still shown:
   * a WhatsApp QR query that errors must not hide the OAuth accounts that loaded
   * fine, and vice versa. The banner shows the flag and offers a retry.
   */
  partialError: { scope: ReconnectCheckScope } | null;
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
    queryFn: async (): Promise<AccountsNeedingReconnectResult> => {
      if (!user) return { accounts: [], partialError: null };

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

      // Both halves failed: there is nothing to show and nothing partial about it.
      // Rethrowing keeps react-query's failed state, its backoff and its retry.
      if (active.error && whatsappQr.error) throw active.error;

      const activeRows = (active.error ? [] : (active.data ?? [])) as AccountNeedingReconnect[];
      const qrRows = (whatsappQr.error ? [] : (whatsappQr.data ?? [])) as AccountNeedingReconnect[];

      const merged = [...activeRows, ...qrRows];
      const seen = new Set<string>();
      const accounts = merged.filter((account) => {
        if (seen.has(account.id)) return false;
        seen.add(account.id);
        return true;
      });

      const partialError = active.error
        ? ({ scope: "active" } as const)
        : whatsappQr.error
          ? ({ scope: "whatsapp_qr" } as const)
          : null;

      return { accounts, partialError };
    },
  });
}
