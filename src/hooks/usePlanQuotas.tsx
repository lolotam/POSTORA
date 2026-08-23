import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

export interface PlanQuota {
  id: string;
  plan_slug: string;
  plan_name: string;
  profile_limit: number | null;
  max_social_accounts: number | null;
  max_posts_per_month: number | null;
  max_posts_per_day: number | null;
  max_media_uploads_per_day: number | null;
}

/**
 * Owns every Supabase call for plan entitlements. ARCHITECTURE.md section 11
 * forbids raw queries inside pages; AdminPlanQuotas consumes this instead.
 *
 * NULL semantics (binding project rule): a NULL numeric column means "fall
 * back to the built-in Free-tier default in effective_user_quotas". NULL is
 * preserved on read and sent back as NULL on write — never coerced to 0,
 * because a saved 0 would mean "this plan allows zero" and lock out its
 * users. -1 means unlimited.
 */
export function usePlanQuotas() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data: quotas = [], isLoading } = useQuery({
    queryKey: ["plan-quotas"],
    queryFn: async (): Promise<PlanQuota[]> => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select(
          "id, slug, name, profile_limit, max_social_accounts, max_posts_per_month, max_posts_per_day, max_media_uploads_per_day"
        )
        .order("sort_order");
      if (error) throw error;
      return (data ?? []).map((row) => ({
        id: row.id,
        plan_slug: row.slug,
        plan_name: row.name,
        profile_limit: row.profile_limit,
        max_social_accounts: row.max_social_accounts,
        max_posts_per_month: row.max_posts_per_month,
        max_posts_per_day: row.max_posts_per_day,
        max_media_uploads_per_day: row.max_media_uploads_per_day,
      }));
    },
  });

  const updateQuota = useMutation({
    mutationFn: async (plan: PlanQuota) => {
      const { error } = await supabase
        .from("subscription_plans")
        .update({
          profile_limit: plan.profile_limit,
          max_social_accounts: plan.max_social_accounts,
          max_posts_per_month: plan.max_posts_per_month,
          max_posts_per_day: plan.max_posts_per_day,
          max_media_uploads_per_day: plan.max_media_uploads_per_day,
          updated_at: new Date().toISOString(),
        })
        .eq("id", plan.id);
      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["plan-quotas"] });
      queryClient.invalidateQueries({ queryKey: ["plan-entitlements"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans-all"] });
      toast({
        title: "Quotas updated",
        description: "Plan quotas saved. Users inherit them immediately.",
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

  return { quotas, isLoading, updateQuota };
}
