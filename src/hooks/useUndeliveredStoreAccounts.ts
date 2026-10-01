import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";

// Mirrors the columns the dashboard banner renders: the account label plus the
// undelivered flag the store receiver raises (PR-D).
export interface FlaggedUndeliveredAccount {
  id: string;
  platform_username: string | null;
  account_metadata: { undelivered_store_events?: { since?: string } } | null;
}

export function useUndeliveredStoreAccounts() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["undelivered-store-orders", user?.id],
    enabled: !!user,
    refetchInterval: 60000,
    queryFn: async () => {
      const { data: rows, error } = await supabase
        .from("social_accounts")
        .select("id, platform_username, account_metadata")
        .eq("user_id", user!.id)
        .eq("platform", "whatsapp")
        .not("account_metadata->undelivered_store_events", "is", null);
      if (error) return [];
      return (rows ?? []) as FlaggedUndeliveredAccount[];
    },
  });
}
