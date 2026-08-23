import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface SubscriptionPlan {
  id: string;
  name: string;
  slug: string;
  price_monthly: number | null;
  price_yearly: number | null;
  features: string[];
  // NULL means "no explicit limit on this plan" — it falls back to the
  // built-in Free-tier default (FREE_TIER_FALLBACK.max_profiles in
  // useQuotas.tsx) through effective_user_quotas(). AdminPlanQuotas already
  // writes NULL here (it is the same subscription_plans.profile_limit
  // column), so this must match types.ts's generated `number | null`
  // instead of lying that it is always a number (I2/minor-3, 2026-08-23
  // final review).
  profile_limit: number | null;
  is_popular: boolean;
  is_active: boolean;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

export function useSubscriptionPlans() {
  return useQuery({
    queryKey: ["subscription-plans"],
    queryFn: async (): Promise<SubscriptionPlan[]> => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .eq("is_active", true)
        .order("sort_order", { ascending: true });

      if (error) throw error;

      return (data || []).map((plan) => ({
        ...plan,
        features: Array.isArray(plan.features) ? plan.features : [],
      })) as SubscriptionPlan[];
    },
  });
}

export function useAllSubscriptionPlans() {
  return useQuery({
    queryKey: ["subscription-plans-all"],
    queryFn: async (): Promise<SubscriptionPlan[]> => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .select("*")
        .order("sort_order", { ascending: true });

      if (error) throw error;

      return (data || []).map((plan) => ({
        ...plan,
        features: Array.isArray(plan.features) ? plan.features : [],
      })) as SubscriptionPlan[];
    },
  });
}

export function useUpdateSubscriptionPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      id,
      ...updates
    }: Partial<SubscriptionPlan> & { id: string }) => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .update(updates)
        .eq("id", id)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription-plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans-all"] });
    },
  });
}

export function useCreateSubscriptionPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (
      plan: Omit<SubscriptionPlan, "id" | "created_at" | "updated_at">
    ) => {
      const { data, error } = await supabase
        .from("subscription_plans")
        .insert(plan)
        .select()
        .single();

      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription-plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans-all"] });
    },
  });
}

export function useDeleteSubscriptionPlan() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase
        .from("subscription_plans")
        .delete()
        .eq("id", id);

      if (error) throw error;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["subscription-plans"] });
      queryClient.invalidateQueries({ queryKey: ["subscription-plans-all"] });
    },
  });
}
