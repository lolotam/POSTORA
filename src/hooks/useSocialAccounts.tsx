import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { Platform } from "@/lib/types";
import type { LinkedInPage } from "@/components/post/settings/LinkedInSettings";

export interface SocialAccount {
  id: string;
  user_id: string;
  platform: Platform;
  platform_user_id: string;
  platform_username: string | null;
  avatar_url: string | null;
  is_active: boolean;
  connected_at: string;
  connection_mode: "cloud_api" | "coexistence" | "evolution_qr" | null;
  updated_at: string;
  social_profile_id: string | null;
  token_expires_at: string | null;
  needs_reauth: boolean | null;
  account_metadata?: {
    linkedin_pages?: LinkedInPage[];
    [key: string]: unknown;
  } | null;
}

export function useSocialAccounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["social_accounts", user?.id],
    queryFn: async () => {
      if (!user) return [];

      // Get accounts that are active AND either have no profile OR belong to a profile the user owns
      const { data, error } = await supabase
        .from("social_accounts")
        .select(`
          id, user_id, platform, platform_user_id, platform_username, avatar_url, is_active, connected_at, connection_mode, updated_at, social_profile_id, account_metadata, token_expires_at, needs_reauth, auth_provider,
          social_profiles!social_accounts_social_profile_id_fkey(id, user_id)
        `)
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (error) throw error;
      
      // Filter out accounts linked to profiles owned by other users
      const validAccounts = (data || []).filter((account: any) => {
        // No profile linked - valid
        if (!account.social_profile_id) return true;
        // Profile exists and belongs to current user - valid
        if (account.social_profiles && account.social_profiles.user_id === user.id) return true;
        // Profile linked but doesn't exist or belongs to other user - invalid (orphaned)
        return false;
      });

      return validAccounts as SocialAccount[];
    },
    enabled: !!user,
    retry: false,
  });
}

export function useDisconnectAccount() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (accountId: string) => {
      const { error } = await supabase
        .from("social_accounts")
        .update({ is_active: false })
        .eq("id", accountId)
        .eq("user_id", user?.id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_accounts"] });
    },
  });
}
