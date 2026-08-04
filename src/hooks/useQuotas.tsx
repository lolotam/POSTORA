import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useUserRole } from "@/hooks/useUserRole";
import { useSubscription } from "@/hooks/useSubscription";

export interface UserQuota {
  id: string;
  user_id: string;
  max_profiles: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  posts_this_month: number;
  max_posts_per_day: number;
  posts_today: number;
  daily_reset_date: string;
  quota_reset_date: string;
  media_uploads_today: number;
  max_media_uploads_per_day: number;
  media_daily_reset_date: string;
  created_at: string;
  updated_at: string;
}

// Plan-based quota limits (matches stripe-webhook PLAN_QUOTAS and /pricing page)
// FREE: 2 profiles, 3 accounts, 30 posts/mo, 2 posts/day, 20 uploads/day
// PRO: 15 profiles, 30 accounts, 500 posts/mo, 30 posts/day, unlimited uploads
// BUSINESS: unlimited everything
const PLAN_QUOTAS = {
  free: {
    max_profiles: 2,
    max_social_accounts: 3,
    max_posts_per_month: 30,
    max_posts_per_day: 2,
    max_media_uploads_per_day: 20,
  },
  pro: {
    max_profiles: 15,
    max_social_accounts: 30,
    max_posts_per_month: 500,
    max_posts_per_day: 30,
    max_media_uploads_per_day: -1, // unlimited
  },
  business: {
    max_profiles: -1, // unlimited
    max_social_accounts: -1,
    max_posts_per_month: -1,
    max_posts_per_day: -1,
    max_media_uploads_per_day: -1,
  },
};

export function useQuotas() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useUserRole();
  const { planSlug, isSubscribed } = useSubscription();

  // Determine effective limits based on subscription
  const effectivePlanSlug = isSubscribed ? planSlug : "free";
  const basePlanLimits = PLAN_QUOTAS[effectivePlanSlug as keyof typeof PLAN_QUOTAS] || PLAN_QUOTAS.free;

  // Use the higher of plan-based limits vs actual DB quotas (admin may have set higher values)
  const { data: dbQuotaLimits } = useQuery({
    queryKey: ["user-quota-limits", user?.id],
    queryFn: async () => {
      if (!user?.id) return null;
      const { data, error } = await supabase
        .from("user_quotas")
        .select("max_profiles, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    },
    enabled: !!user?.id,
    staleTime: 60_000,
  });

  // Helper: pick the more permissive limit (-1 = unlimited wins always)
  const pickMax = (a: number, b: number) => {
    if (a === -1 || b === -1) return -1;
    return Math.max(a, b);
  };

  const planLimits = dbQuotaLimits
    ? {
        max_profiles: pickMax(basePlanLimits.max_profiles, dbQuotaLimits.max_profiles),
        max_social_accounts: pickMax(basePlanLimits.max_social_accounts, dbQuotaLimits.max_social_accounts),
        max_posts_per_month: pickMax(basePlanLimits.max_posts_per_month, dbQuotaLimits.max_posts_per_month),
        max_posts_per_day: pickMax(basePlanLimits.max_posts_per_day, dbQuotaLimits.max_posts_per_day),
        max_media_uploads_per_day: pickMax(basePlanLimits.max_media_uploads_per_day, dbQuotaLimits.max_media_uploads_per_day),
      }
    : basePlanLimits;

  const { data: quota, isLoading } = useQuery({
    queryKey: ["user-quota", user?.id],
    queryFn: async (): Promise<UserQuota | null> => {
      if (!user?.id) return null;

      const { data, error } = await supabase
        .from("user_quotas")
        .select("*")
        .eq("user_id", user.id)
        .maybeSingle();

      if (error) {
        console.error("Error fetching quota:", error);
        return null;
      }

      if (!data) return null;

      // Normalize stale counters: if reset dates have expired, zero the counters
      const now = new Date();
      const updates: {
        posts_today?: number;
        daily_reset_date?: string;
        posts_this_month?: number;
        quota_reset_date?: string;
        media_uploads_today?: number;
        media_daily_reset_date?: string;
      } = {};
      let normalized = { ...data } as UserQuota;

      // Daily reset check
      const dailyReset = new Date(data.daily_reset_date || now);
      if (now >= dailyReset) {
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        normalized.posts_today = 0;
        updates.posts_today = 0;
        updates.daily_reset_date = nextMidnight.toISOString();
        normalized.daily_reset_date = nextMidnight.toISOString();
      }

      // Monthly reset check
      const monthlyReset = new Date(data.quota_reset_date || now);
      if (now >= monthlyReset) {
        const nextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1);
        normalized.posts_this_month = 0;
        updates.posts_this_month = 0;
        updates.quota_reset_date = nextMonth.toISOString();
        normalized.quota_reset_date = nextMonth.toISOString();
      }

      // Media daily reset check
      const mediaReset = new Date(data.media_daily_reset_date || now);
      if (now >= mediaReset) {
        const nextMidnight = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
        normalized.media_uploads_today = 0;
        updates.media_uploads_today = 0;
        updates.media_daily_reset_date = nextMidnight.toISOString();
        normalized.media_daily_reset_date = nextMidnight.toISOString();
      }

      // Persist corrections in the background (fire-and-forget)
      if (Object.keys(updates).length > 0) {
        supabase
          .from("user_quotas")
          .update(updates)
          .eq("user_id", user.id)
          .then(({ error: updateErr }) => {
            if (updateErr) console.error("Failed to persist quota reset:", updateErr);
          });
      }

      return normalized;
    },
    enabled: !!user?.id,
  });

  // Fetch REAL usage by counting actual rows in the posts table
  const { data: realUsage, isLoading: isLoadingRealUsage } = useQuery({
    queryKey: ["real-usage", user?.id],
    queryFn: async () => {
      if (!user?.id) return { postsToday: 0, postsThisMonth: 0, mediaUploadsToday: 0 };

      const now = new Date();
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

      const [dailyResult, monthlyResult, mediaResult] = await Promise.all([
        supabase
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", startOfDay),
        supabase
          .from("posts")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", startOfMonth),
        supabase
          .from("media_files")
          .select("*", { count: "exact", head: true })
          .eq("user_id", user.id)
          .gte("created_at", startOfDay),
      ]);

      return {
        postsToday: dailyResult.count || 0,
        postsThisMonth: monthlyResult.count || 0,
        mediaUploadsToday: mediaResult.count || 0,
      };
    },
    enabled: !!user?.id,
  });

  // Helper to check if unlimited (-1 means unlimited)
  const isUnlimited = (limit: number) => limit === -1;

  // Check if user can create a new profile
  const canCreateProfile = async (): Promise<{ allowed: boolean; message?: string }> => {
    if (!user?.id) return { allowed: false, message: "Not authenticated" };
    
    // Admins have no limits
    if (isAdmin) return { allowed: true };

    // Use subscription-based limits (Pro/Business get higher limits)
    const maxProfiles = planLimits.max_profiles;
    
    // Unlimited profiles
    if (isUnlimited(maxProfiles)) return { allowed: true };

    const { count } = await supabase
      .from("social_profiles")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id);

    if ((count || 0) >= maxProfiles) {
      return {
        allowed: false,
        message: `You've reached your limit of ${maxProfiles} profile(s). Upgrade your plan to add more.`,
      };
    }

    return { allowed: true };
  };

  // Check if user can connect a new social account to a profile
  const canConnectSocialAccount = async (profileId: string): Promise<{ allowed: boolean; message?: string }> => {
    if (!user?.id) return { allowed: false, message: "Not authenticated" };
    
    // Admins have no limits
    if (isAdmin) return { allowed: true };

    // Use subscription-based limits
    const maxSocialAccounts = planLimits.max_social_accounts;
    
    // Unlimited accounts
    if (isUnlimited(maxSocialAccounts)) return { allowed: true };

    const { count } = await supabase
      .from("social_accounts")
      .select("*", { count: "exact", head: true })
      .eq("user_id", user.id)
      .eq("social_profile_id", profileId)
      .eq("is_active", true);

    if ((count || 0) >= maxSocialAccounts) {
      return {
        allowed: false,
        message: `You've reached your limit of ${maxSocialAccounts} social accounts per profile. Upgrade to connect more.`,
      };
    }

    return { allowed: true };
  };

  // Check if user can create a new post (checks both daily and monthly limits)
  // Prefer DB RPC (same rules as INSERT trigger); fall back to real post counts.
  const canCreatePost = async (): Promise<{ allowed: boolean; message?: string; remaining?: number }> => {
    if (!user?.id) return { allowed: false, message: "Not authenticated" };
    
    // Admins have no limits
    if (isAdmin) return { allowed: true, remaining: 999999 };

    const maxPostsPerDay = planLimits.max_posts_per_day;
    const maxPostsPerMonth = planLimits.max_posts_per_month;

    if (isUnlimited(maxPostsPerDay) && isUnlimited(maxPostsPerMonth)) {
      return { allowed: true, remaining: 999999 };
    }

    // Server-side check (authoritative when migration is applied)
    const { data: rpcAllowed, error: rpcError } = await supabase.rpc("can_create_post", {
      p_user_id: user.id,
    });

    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).toISOString();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();

    const [dailyResult, monthlyResult] = await Promise.all([
      supabase
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", startOfDay),
      supabase
        .from("posts")
        .select("*", { count: "exact", head: true })
        .eq("user_id", user.id)
        .gte("created_at", startOfMonth),
    ]);

    const postsToday = dailyResult.count ?? 0;
    const postsThisMonth = monthlyResult.count ?? 0;

    if (!rpcError && rpcAllowed === false) {
      if (!isUnlimited(maxPostsPerDay) && postsToday >= maxPostsPerDay) {
        return {
          allowed: false,
          message: `You've used all ${maxPostsPerDay} post(s) for today. Your daily limit resets at midnight.`,
          remaining: 0,
        };
      }
      return {
        allowed: false,
        message: `You've used all ${maxPostsPerMonth} posts this month. Posts renew on the 1st of next month.`,
        remaining: 0,
      };
    }

    // Client-side fallback / remaining calculation using real post counts
    if (!isUnlimited(maxPostsPerDay) && postsToday >= maxPostsPerDay) {
      return {
        allowed: false,
        message: `You've used all ${maxPostsPerDay} post(s) for today. Your daily limit resets at midnight.`,
        remaining: 0,
      };
    }

    if (!isUnlimited(maxPostsPerMonth) && postsThisMonth >= maxPostsPerMonth) {
      return {
        allowed: false,
        message: `You've used all ${maxPostsPerMonth} posts this month. Posts renew on the 1st of next month.`,
        remaining: 0,
      };
    }

    const remainingDaily = isUnlimited(maxPostsPerDay) ? 999999 : maxPostsPerDay - postsToday;
    const remainingMonthly = isUnlimited(maxPostsPerMonth) ? 999999 : maxPostsPerMonth - postsThisMonth;

    return { allowed: true, remaining: Math.min(remainingDaily, remainingMonthly) };
  };

  // Check if user can upload media
  const canUploadMedia = async (): Promise<{ allowed: boolean; message?: string; remaining?: number }> => {
    if (!user?.id) return { allowed: false, message: "Not authenticated" };
    
    // Admins have no limits
    if (isAdmin) return { allowed: true, remaining: 999999 };

    // Use subscription-based limits
    const maxMediaUploads = planLimits.max_media_uploads_per_day;
    
    // Unlimited uploads for Pro/Business
    if (isUnlimited(maxMediaUploads)) {
      return { allowed: true, remaining: 999999 };
    }

    // Use the database function to check
    const { data, error } = await supabase.rpc("can_upload_media", { p_user_id: user.id });

    if (error) {
      console.error("Error checking media upload quota:", error);
      return { allowed: true }; // Default to allowed on error
    }

    if (!data) {
      // Get quota info for message
      const { data: quotaData } = await supabase
        .from("user_quotas")
        .select("media_uploads_today, max_media_uploads_per_day")
        .eq("user_id", user.id)
        .single();

      const max = quotaData?.max_media_uploads_per_day ?? 20;
      return {
        allowed: false,
        message: `You've reached your daily limit of ${max} media uploads. Upgrade to Pro for unlimited uploads.`,
        remaining: 0,
      };
    }

    return { allowed: true };
  };

  // Increment media upload count after successful upload
  const incrementMediaUpload = async (): Promise<boolean> => {
    if (!user?.id) return false;

    const { data, error } = await supabase.rpc("increment_media_uploads", { p_user_id: user.id });

    if (error) {
      console.error("Error incrementing media upload:", error);
      return true; // Don't block on error
    }

    queryClient.invalidateQueries({ queryKey: ["user-quota", user.id] });
    return data ?? true;
  };

  // Increment post count after successful post (both daily and monthly)
  const incrementPostCount = async () => {
    if (!user?.id) return;

    const { data: quotaData } = await supabase
      .from("user_quotas")
      .select("posts_this_month, posts_today")
      .eq("user_id", user.id)
      .single();

    if (quotaData) {
      await supabase
        .from("user_quotas")
        .update({
          posts_this_month: (quotaData.posts_this_month || 0) + 1,
          posts_today: (quotaData.posts_today || 0) + 1,
        })
        .eq("user_id", user.id);

      queryClient.invalidateQueries({ queryKey: ["user-quota", user.id] });
    }
  };

  // Get current usage counts
  const getUsageCounts = async (): Promise<{ profiles: number; socialAccounts: number; postsUsed: number }> => {
    if (!user?.id) return { profiles: 0, socialAccounts: 0, postsUsed: 0 };

    const [profilesResult, accountsResult] = await Promise.all([
      supabase.from("social_profiles").select("*", { count: "exact", head: true }).eq("user_id", user.id),
      supabase.from("social_accounts").select("*", { count: "exact", head: true }).eq("user_id", user.id).eq("is_active", true),
    ]);

    return {
      profiles: profilesResult.count || 0,
      socialAccounts: accountsResult.count || 0,
      postsUsed: quota?.posts_this_month || 0,
    };
  };

  return {
    quota,
    isLoading: isLoading || isLoadingRealUsage,
    realUsage: realUsage || { postsToday: 0, postsThisMonth: 0, mediaUploadsToday: 0 },
    canCreateProfile,
    canConnectSocialAccount,
    canCreatePost,
    canUploadMedia,
    incrementPostCount,
    incrementMediaUpload,
    getUsageCounts,
    planLimits,
    effectivePlanSlug,
  };
}

// Hook for admin to manage user quotas
export function useAdminQuotas() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const updateQuotaMutation = useMutation({
    mutationFn: async ({
      userId,
      maxProfiles,
      maxSocialAccounts,
      maxPostsPerMonth,
      maxPostsPerDay,
      maxMediaUploadsPerDay,
    }: {
      userId: string;
      maxProfiles: number;
      maxSocialAccounts: number;
      maxPostsPerMonth: number;
      maxPostsPerDay: number;
      maxMediaUploadsPerDay?: number;
    }) => {
      const updateData: Record<string, number> = {
        max_profiles: maxProfiles,
        max_social_accounts: maxSocialAccounts,
        max_posts_per_month: maxPostsPerMonth,
        max_posts_per_day: maxPostsPerDay,
      };
      
      if (maxMediaUploadsPerDay !== undefined) {
        updateData.max_media_uploads_per_day = maxMediaUploadsPerDay;
      }

      const { error } = await supabase
        .from("user_quotas")
        .upsert({
          user_id: userId,
          ...updateData,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" });

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({
        title: "Quota updated",
        description: "User quota has been updated successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update quota",
        variant: "destructive",
      });
    },
  });

  const bulkUpdateQuotaMutation = useMutation({
    mutationFn: async ({
      userIds,
      maxProfiles,
      maxSocialAccounts,
      maxPostsPerMonth,
      maxPostsPerDay,
      maxMediaUploadsPerDay,
    }: {
      userIds: string[];
      maxProfiles: number;
      maxSocialAccounts: number;
      maxPostsPerMonth: number;
      maxPostsPerDay: number;
      maxMediaUploadsPerDay?: number;
    }) => {
      const updateData: Record<string, number> = {
        max_profiles: maxProfiles,
        max_social_accounts: maxSocialAccounts,
        max_posts_per_month: maxPostsPerMonth,
        max_posts_per_day: maxPostsPerDay,
      };
      
      if (maxMediaUploadsPerDay !== undefined) {
        updateData.max_media_uploads_per_day = maxMediaUploadsPerDay;
      }

      const promises = userIds.map(uid =>
        supabase.from("user_quotas").upsert({
          user_id: uid,
          ...updateData,
          updated_at: new Date().toISOString(),
        }, { onConflict: "user_id" })
      );
      const results = await Promise.all(promises);
      const firstError = results.find(r => r.error);
      if (firstError?.error) throw firstError.error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({
        title: "Quotas updated",
        description: "User quotas have been updated successfully.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to update quotas",
        variant: "destructive",
      });
    },
  });

  const bulkDeleteUsersMutation = useMutation({
    mutationFn: async (userIds: string[]) => {
      // Delete user data in order due to foreign key constraints
      // First delete related data
      await supabase.from("platform_posts").delete().in("post_id", 
        (await supabase.from("posts").select("id").in("user_id", userIds)).data?.map(p => p.id) || []
      );
      await supabase.from("posts").delete().in("user_id", userIds);
      await supabase.from("social_accounts").delete().in("user_id", userIds);
      await supabase.from("social_profiles").delete().in("user_id", userIds);
      await supabase.from("user_quotas").delete().in("user_id", userIds);
      await supabase.from("user_roles").delete().in("user_id", userIds);
      await supabase.from("profiles").delete().in("id", userIds);
      
      // Note: The actual auth.users deletion requires Supabase Admin API
      // which is not available from the client
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["admin-users"] });
      toast({
        title: "Users deleted",
        description: "Selected users and their data have been deleted.",
      });
    },
    onError: (error) => {
      toast({
        title: "Error",
        description: error instanceof Error ? error.message : "Failed to delete users",
        variant: "destructive",
      });
    },
  });

  return {
    updateQuota: updateQuotaMutation.mutate,
    isUpdating: updateQuotaMutation.isPending,
    bulkUpdateQuota: bulkUpdateQuotaMutation.mutate,
    isBulkUpdating: bulkUpdateQuotaMutation.isPending,
    bulkDeleteUsers: bulkDeleteUsersMutation.mutate,
    isBulkDeleting: bulkDeleteUsersMutation.isPending,
  };
}
