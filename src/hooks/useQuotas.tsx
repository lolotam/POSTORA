import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useToast } from "@/hooks/use-toast";
import { useUserRole } from "@/hooks/useUserRole";
import { useSubscription } from "@/hooks/useSubscription";

// Round-2 fix (final review I2): the five max_* columns are NULL-means-inherit
// (see resolvePlanLimits below and supabase/migrations/20260823140100). This
// interface previously declared them non-null `number`, which was a lying
// type that let every `?? <hardcoded default>` consumer compile without the
// compiler ever flagging them. types.ts (the generated Supabase schema) has
// always had these correctly as `number | null` — this interface must match it.
export interface UserQuota {
  id: string;
  user_id: string;
  max_profiles: number | null;
  max_social_accounts: number | null;
  max_posts_per_month: number | null;
  posts_this_month: number;
  max_posts_per_day: number | null;
  posts_today: number;
  daily_reset_date: string;
  quota_reset_date: string;
  media_uploads_today: number;
  max_media_uploads_per_day: number | null;
  media_daily_reset_date: string;
  created_at: string;
  updated_at: string;
}

/** Last-resort limits, used ONLY when the subscription_plans query fails.
 *  The database's effective_user_quotas() holds the same numbers; these two
 *  must stay in sync so an outage never enforces something the DB disagrees with. */
export const FREE_TIER_FALLBACK: QuotaLimits = {
  max_profiles: 2,
  max_social_accounts: 3,
  max_posts_per_month: 30,
  max_posts_per_day: 2,
  max_media_uploads_per_day: 20,
};

export interface QuotaLimits {
  max_profiles: number;
  max_social_accounts: number;
  max_posts_per_month: number;
  max_posts_per_day: number;
  max_media_uploads_per_day: number;
}

type PlanRow = (Partial<QuotaLimits> & { profile_limit?: number | null }) | null;

/** Mirrors the SQL arbiter effective_user_quotas(): override -> plan -> fallback,
 *  resolved per column. A null override column means inherit, NOT zero. */
export function resolvePlanLimits(plan: PlanRow, override: Partial<QuotaLimits> | null): QuotaLimits {
  const pick = (o: number | null | undefined, p: number | null | undefined, f: number) =>
    o ?? p ?? f;
  return {
    max_profiles: pick(override?.max_profiles, plan?.profile_limit, FREE_TIER_FALLBACK.max_profiles),
    max_social_accounts: pick(override?.max_social_accounts, plan?.max_social_accounts, FREE_TIER_FALLBACK.max_social_accounts),
    max_posts_per_month: pick(override?.max_posts_per_month, plan?.max_posts_per_month, FREE_TIER_FALLBACK.max_posts_per_month),
    max_posts_per_day: pick(override?.max_posts_per_day, plan?.max_posts_per_day, FREE_TIER_FALLBACK.max_posts_per_day),
    max_media_uploads_per_day: pick(override?.max_media_uploads_per_day, plan?.max_media_uploads_per_day, FREE_TIER_FALLBACK.max_media_uploads_per_day),
  };
}

/** The denial message must quote the resolved limit (which may be a lowered plan
 *  value), never a hardcoded free-tier default. */
export function mediaUploadLimitMessage(max: number): string {
  return `You've reached your daily limit of ${max} media uploads. Upgrade to Pro for unlimited uploads.`;
}

// F6 (CodeRabbit round 1, 2026-08-23): query-option factories, shared
// between the reactive useQuery() calls below (for render-time display)
// and queryClient.ensureQueryData() inside the enforcement helpers (for a
// readiness-awaited decision). Extracted so both call sites use the
// identical queryKey/queryFn — a mismatch would mean the imperative
// ensureQueryData() call populates a different cache entry than the one
// useQuery() is reading, defeating the point of awaiting it.
function dbQuotaLimitsQueryOptions(userId: string | undefined) {
  return {
    queryKey: ["user-quota-limits", userId] as const,
    queryFn: async () => {
      if (!userId) return null;
      const { data, error } = await supabase
        .from("user_quotas")
        .select("max_profiles, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day")
        .eq("user_id", userId)
        .maybeSingle();
      if (error || !data) return null;
      return data;
    },
    enabled: !!userId,
    staleTime: 60_000,
  };
}

function planEntitlementsQueryOptions(planSlug: string) {
  return {
    queryKey: ["plan-entitlements", planSlug] as const,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("profile_limit, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day")
        .eq("slug", planSlug)
        .maybeSingle();
      if (error) {
        console.error("Error fetching plan entitlements:", error);
        return null;
      }
      return data;
    },
    staleTime: 60_000,
  };
}

export function useQuotas() {
  const { user } = useAuth();
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const { isAdmin } = useUserRole();
  const { planSlug, isSubscribed } = useSubscription();

  // Determine effective limits based on subscription
  const effectivePlanSlug = isSubscribed ? planSlug : "free";

  // Per-user override row (user_quotas). NULL columns mean inherit from the plan.
  const { data: dbQuotaLimits, isLoading: isLoadingDbQuotaLimits } = useQuery(
    dbQuotaLimitsQueryOptions(user?.id),
  );

  // A dedicated plan query rather than useSubscription: that hook returns
  // dbSubscription: null for a user with no subscription row, so it never
  // carries a plan row for free users — who are the majority.
  const { data: planRow, isLoading: isLoadingPlanRow } = useQuery(
    planEntitlementsQueryOptions(effectivePlanSlug),
  );

  // F6: true while either query backing planLimits hasn't settled yet.
  // Exposed so a display consumer can show a loading state instead of the
  // FREE_TIER_FALLBACK placeholder if it chooses to.
  const isEntitlementsLoading = isLoadingDbQuotaLimits || isLoadingPlanRow;

  // Resolution order mirrors the SQL arbiter effective_user_quotas():
  // per-user override -> plan -> FREE_TIER_FALLBACK. A NULL override column
  // means inherit from the plan; the old pickMax() "higher of the two" logic
  // is gone — an admin override may legitimately LOWER a limit.
  const planLimits = resolvePlanLimits(planRow ?? null, dbQuotaLimits ?? null);

  // F6: the enforcement helpers below (canCreateProfile, canConnectSocialAccount,
  // canCreatePost, canUploadMedia) must never make an allow/deny decision
  // off `planLimits` while it is still the FREE_TIER_FALLBACK placeholder
  // (nothing resolved yet). queryClient.ensureQueryData() returns the
  // already-cached value if fresh, or awaits the in-flight/next fetch — so
  // a helper called during the loading window now waits for the REAL data
  // instead of deciding against a hardcoded Free-tier stand-in. Never
  // flips to "allow everything": it always resolves to real data, it just
  // may take a moment longer while data is in flight.
  const getReadyPlanLimits = async (): Promise<QuotaLimits> => {
    if (!user?.id) return planLimits;
    const [db, plan] = await Promise.all([
      queryClient.ensureQueryData(dbQuotaLimitsQueryOptions(user.id)),
      queryClient.ensureQueryData(planEntitlementsQueryOptions(effectivePlanSlug)),
    ]);
    return resolvePlanLimits(plan ?? null, db ?? null);
  };

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

    // F6: await real entitlement data rather than deciding off `planLimits`,
    // which may still be the FREE_TIER_FALLBACK placeholder this early.
    const maxProfiles = (await getReadyPlanLimits()).max_profiles;

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

    // F6: await real entitlement data rather than deciding off `planLimits`,
    // which may still be the FREE_TIER_FALLBACK placeholder this early.
    const maxSocialAccounts = (await getReadyPlanLimits()).max_social_accounts;

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

    // F6: await real entitlement data rather than deciding off `planLimits`,
    // which may still be the FREE_TIER_FALLBACK placeholder this early.
    const readyLimits = await getReadyPlanLimits();
    const maxPostsPerDay = readyLimits.max_posts_per_day;
    const maxPostsPerMonth = readyLimits.max_posts_per_month;

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

    // F6: await real entitlement data rather than deciding off `planLimits`,
    // which may still be the FREE_TIER_FALLBACK placeholder this early.
    const maxMediaUploads = (await getReadyPlanLimits()).max_media_uploads_per_day;

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
      return {
        allowed: false,
        message: mediaUploadLimitMessage(maxMediaUploads),
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
      // F1 (CodeRabbit round 1): increment_media_uploads() atomically checks
      // AND increments in one call. An RPC error means that call did not run
      // to completion (e.g. two concurrent first uploads racing the
      // user_quotas.user_id unique key), so nothing was recorded for THIS
      // upload. Treating that as "allowed" let two concurrent requests both
      // upload past the same limit. Fail closed instead.
      return false;
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
    // F6: whether planLimits above is still resolving (still possibly the
    // FREE_TIER_FALLBACK placeholder). The canX() enforcement helpers never
    // need this - they already await getReadyPlanLimits() internally - but
    // a display consumer can use it to show a loading state instead of a
    // number that may not reflect the user's real plan yet.
    isEntitlementsLoading,
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
      // null is a real, deliberate value here: "clear this override, inherit
      // from the plan". Widened from `number` so an admin can actually send
      // it - Record<string, number> made NULL unrepresentable and the only
      // way to clear an override was a role change.
      maxProfiles: number | null;
      maxSocialAccounts: number | null;
      maxPostsPerMonth: number | null;
      maxPostsPerDay: number | null;
      maxMediaUploadsPerDay?: number | null;
    }) => {
      const updateData: Record<string, number | null> = {
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
      maxProfiles: number | null;
      maxSocialAccounts: number | null;
      maxPostsPerMonth: number | null;
      maxPostsPerDay: number | null;
      maxMediaUploadsPerDay?: number | null;
    }) => {
      const updateData: Record<string, number | null> = {
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
