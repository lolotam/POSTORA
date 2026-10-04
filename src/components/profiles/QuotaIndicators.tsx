import { useEffect, useState } from "react";
import { Progress } from "@/components/ui/progress";
import { useQuotas } from "@/hooks/useQuotas";
import { useUserRole } from "@/hooks/useUserRole";
import { useSubscription } from "@/hooks/useSubscription";
import { User, Share2, FileText, Calendar, ImagePlus } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { Reveal, Icon3D, GradientRingCard, type GradientKey } from "@/components/fx";

export function QuotaIndicators() {
  const { quota, isLoading, planLimits, effectivePlanSlug, realUsage } = useQuotas();
  const { isAdmin } = useUserRole();
  const { planName } = useSubscription();
  const { user } = useAuth();
  const [profileCount, setProfileCount] = useState(0);
  const [socialAccountCount, setSocialAccountCount] = useState(0);
  const [loadingCounts, setLoadingCounts] = useState(true);

  useEffect(() => {
    const fetchCounts = async () => {
      if (!user?.id) {
        setLoadingCounts(false);
        return;
      }

      try {
        const [profilesResult, accountsResult] = await Promise.all([
          supabase.from("social_profiles").select("*", { count: "exact", head: true }).eq("user_id", user.id),
          supabase
            .from("social_accounts")
            .select("*", { count: "exact", head: true })
            .eq("user_id", user.id)
            .eq("is_active", true),
        ]);

        setProfileCount(profilesResult.count || 0);
        setSocialAccountCount(accountsResult.count || 0);
      } catch {
        // Silent error
      } finally {
        setLoadingCounts(false);
      }
    };

    fetchCounts();
  }, [user?.id]);

  if (isAdmin) return null;

  const isBusy = isLoading || loadingCounts;
  if (isBusy) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
        {Array.from({ length: 5 }).map((_, idx) => (
          <div key={idx} className="rounded-3xl border border-border/60 bg-card p-6">
            <div className="animate-pulse">
              <div className="flex items-center justify-between mb-3">
                <div className="h-4 w-24 rounded bg-muted" />
                <div className="h-5 w-10 rounded bg-muted" />
              </div>
              <div className="h-2 w-full rounded bg-muted" />
              <div className="mt-2 h-3 w-32 rounded bg-muted" />
            </div>
          </div>
        ))}
      </div>
    );
  }

  const maxProfiles = planLimits?.max_profiles ?? 2;
  const maxSocialAccounts = planLimits?.max_social_accounts ?? 3;
  const maxPosts = planLimits?.max_posts_per_month ?? 30;
  const maxPostsPerDay = planLimits?.max_posts_per_day ?? 1;
  const maxMediaUploads = planLimits?.max_media_uploads_per_day ?? 20;

  // Use REAL usage from posts table, not stale user_quotas counters
  const postsThisMonth = realUsage.postsThisMonth;
  const postsToday = realUsage.postsToday;
  const mediaUploadsToday = realUsage.mediaUploadsToday;

  const postsRemaining = maxPosts === -1 ? 999999 : Math.max(0, maxPosts - postsThisMonth);
  const dailyPostsRemaining = maxPostsPerDay === -1 ? 999999 : Math.max(0, maxPostsPerDay - postsToday);
  const mediaUploadsRemaining = maxMediaUploads === -1 ? 999999 : Math.max(0, maxMediaUploads - mediaUploadsToday);

  const displayPlanName = planName || (effectivePlanSlug === 'pro' ? 'Pro' : effectivePlanSlug === 'business' ? 'Business' : 'Free');

  const indicators: Array<{
    label: string;
    icon: typeof User;
    current: number;
    max: number;
    variant: GradientKey;
    showRemaining?: boolean;
    description?: string;
    isUnlimited: boolean;
  }> = [
    { label: "Profile",         icon: User,      current: profileCount,            max: maxProfiles,        variant: "sky",     isUnlimited: maxProfiles === -1 },
    { label: "Social Media",    icon: Share2,    current: socialAccountCount,      max: maxSocialAccounts,  variant: "violet",  isUnlimited: maxSocialAccounts === -1 },
    { label: "Posts Available", icon: FileText,  current: postsRemaining,          max: maxPosts,           variant: "emerald", showRemaining: true, description: "posts remaining this month", isUnlimited: maxPosts === -1 },
    { label: "Daily Posts",     icon: Calendar,  current: dailyPostsRemaining,     max: maxPostsPerDay,     variant: "amber",   showRemaining: true, description: "posts remaining today",      isUnlimited: maxPostsPerDay === -1 },
    { label: "Media Uploads",   icon: ImagePlus, current: mediaUploadsRemaining,   max: maxMediaUploads === -1 ? 999999 : maxMediaUploads, variant: "rose", showRemaining: true, description: "uploads remaining today", isUnlimited: maxMediaUploads === -1 },
  ];

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-5 gap-4 mb-6">
      {indicators.map((indicator, i) => {
        const isUnlimited = indicator.isUnlimited;
        const percentage = isUnlimited ? 100 : indicator.showRemaining 
          ? (indicator.current / indicator.max) * 100 
          : (indicator.current / indicator.max) * 100;
        const isAtLimit = !indicator.showRemaining && indicator.current >= indicator.max;
        const isLow = indicator.showRemaining && !isUnlimited && indicator.current <= (indicator.max <= 5 ? 1 : 5);

        return (
          <Reveal key={indicator.label} delay={i * 90}>
            <GradientRingCard variant={indicator.variant} innerClassName="p-5" hoverLift={false}>
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <Icon3D icon={indicator.icon} variant={indicator.variant} size="sm" />
                  <span className="text-sm font-medium">{indicator.label}</span>
                </div>
                <span className={`text-lg font-bold tracking-tight ${isAtLimit || isLow ? 'text-amber-500' : ''}`}>
                  {isUnlimited
                    ? '∞'
                    : indicator.showRemaining
                      ? `${indicator.current}`
                      : `${indicator.current}/${indicator.max}`}
                </span>
              </div>
              <Progress value={percentage} className="h-2" />
              <p className="text-xs text-muted-foreground mt-2">
                {isUnlimited
                  ? `Unlimited (${displayPlanName})`
                  : indicator.showRemaining
                    ? `${indicator.current} of ${indicator.max} ${indicator.description || 'remaining'}`
                    : isAtLimit
                      ? "Limit reached - upgrade to add more"
                      : `${indicator.max - indicator.current} more available`}
              </p>
            </GradientRingCard>
          </Reveal>
        );
      })}
    </div>
  );
}
