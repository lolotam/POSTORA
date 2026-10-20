import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { Platform } from "@/lib/types";

export interface SocialProfile {
  id: string;
  user_id: string;
  name: string;
  share_token: string | null;
  is_public: boolean;
  created_at: string;
  updated_at: string;
}

export interface SocialAccountWithProfile {
  id: string;
  user_id: string;
  platform: Platform;
  platform_user_id: string;
  platform_username: string | null;
  avatar_url: string | null;
  is_active: boolean;
  connected_at: string;
  updated_at: string;
  social_profile_id: string | null;
  token_expires_at: string | null;
  account_metadata: Record<string, unknown> | null;
  ig_auth_type: string | null;
  needs_reauth?: boolean;
  last_refresh_error?: string;
}

export function useSocialProfiles() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["social_profiles", user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from("social_profiles")
        .select("*")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true });

      if (error) throw error;
      return (data || []) as SocialProfile[];
    },
    enabled: !!user,
  });
}

export function useSocialAccountsByProfile(profileId: string) {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["social_accounts", profileId],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, user_id, platform, platform_user_id, platform_username, avatar_url, is_active, connected_at, updated_at, social_profile_id, token_expires_at, account_metadata, ig_auth_type, needs_reauth, last_refresh_error")
        .eq("social_profile_id", profileId)
        .eq("is_active", true);

      if (error) throw error;
      return (data || []) as SocialAccountWithProfile[];
    },
    enabled: !!user && !!profileId,
  });
}

export function useCreateProfile() {
  const queryClient = useQueryClient();
  const { user } = useAuth();

  return useMutation({
    mutationFn: async (name: string) => {
      if (!user) throw new Error("User not authenticated");

      const { data, error } = await supabase
        .from("social_profiles")
        .insert({ user_id: user.id, name })
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
    },
  });
}

export function useRenameProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ profileId, name }: { profileId: string; name: string }) => {
      const { data, error } = await supabase
        .from("social_profiles")
        .update({ name })
        .eq("id", profileId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
    },
  });
}

export function useAllSocialAccounts() {
  const { user } = useAuth();

  return useQuery({
    queryKey: ["all_social_accounts", user?.id],
    queryFn: async () => {
      if (!user) return [];

      const { data, error } = await supabase
        .from("social_accounts")
        .select("id, user_id, platform, platform_user_id, platform_username, avatar_url, is_active, connected_at, updated_at, social_profile_id, token_expires_at, account_metadata, ig_auth_type, needs_reauth, last_refresh_error")
        .eq("user_id", user.id)
        .eq("is_active", true);

      if (error) throw error;
      return (data || []) as SocialAccountWithProfile[];
    },
    enabled: !!user,
  });
}

export function useEnsureDefaultProfile() {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      if (!user) throw new Error("Not authenticated");

      // Check if a default profile already exists
      const { data: existing, error: fetchError } = await supabase
        .from("social_profiles")
        .select("id")
        .eq("user_id", user.id)
        .order("created_at", { ascending: true })
        .limit(1);

      if (fetchError) throw fetchError;
      if (existing && existing.length > 0) return existing[0].id;

      // Create default profile
      const { data, error } = await supabase
        .from("social_profiles")
        .insert({ user_id: user.id, name: "default" })
        .select("id")
        .single();

      if (error) throw error;
      return data.id;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
    },
  });
}

export function useDisconnectAccountFromProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (accountId: string) => {
      const { data: account, error: lookupError } = await supabase.from("social_accounts").select("platform").eq("id", accountId).maybeSingle();
      if (lookupError) throw lookupError;
      if (account?.platform === "tiktok") {
        // Withdraw Postora's TikTok authorization first, so reconnecting shows TikTok's permission screen.
        const { error: revokeError } = await supabase.functions.invoke("tiktok-oauth", { body: { action: "disconnect", social_account_id: accountId } });
        // Best effort, like the revoke itself: removing the account must not depend on TikTok being reachable.
        if (revokeError) console.warn("TikTok revoke before account removal failed:", revokeError);
      }

      const { error } = await supabase
        .from("social_accounts")
        .delete()
        .eq("id", accountId);

      if (error) throw error;
    },
    onSuccess: async () => {
      await queryClient.refetchQueries({ queryKey: ["social_accounts"] });
      await queryClient.refetchQueries({ queryKey: ["social_accounts_by_profile"] });
      await queryClient.refetchQueries({ queryKey: ["social_profiles"] });
      await queryClient.refetchQueries({ queryKey: ["all_social_accounts"] });
    },
  });
}

export function useDeleteProfile() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("social_profiles")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
    },
  });
}

export function useToggleProfilePublic() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({ profileId, isPublic }: { profileId: string; isPublic: boolean }) => {
      // First, check if share_token exists. If not and we're making it public, generate one.
      if (isPublic) {
        const { data: profile } = await supabase
          .from("social_profiles")
          .select("share_token")
          .eq("id", profileId)
          .single();
          
        if (!profile?.share_token) {
          const bytes = new Uint8Array(16);
          crypto.getRandomValues(bytes);
          const shareToken = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
          await supabase
            .from("social_profiles")
            .update({ share_token: shareToken })
            .eq("id", profileId);
        }
      }

      const { data, error } = await supabase
        .from("social_profiles")
        .update({ is_public: isPublic })
        .eq("id", profileId)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["social_profiles"] });
    },
  });
}
