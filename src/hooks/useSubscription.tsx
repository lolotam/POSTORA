import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";

// Stripe Price ID to plan mapping
const PRICE_TO_PLAN: Record<string, string> = {
  "price_1TMF1W07RNvknHFcjDqtIPiG": "pro",     // Pro Monthly (live)
  "price_1TMF1W07RNvknHFce9mxczSu": "pro",     // Pro Yearly (live)
  "price_1TMF1X07RNvknHFcCXqavjD7": "business", // Business Monthly (live)
  "price_1TMF1Y07RNvknHFcnV3Lan1K": "business", // Business Yearly (live)
  "price_1TMF1a07RNvknHFcuZUDzZSb": "pro",     // Pro Monthly Promo (live)
  "price_1TMF1b07RNvknHFckI9I49oD": "pro",     // Pro Yearly Promo (live)
};

export interface UserSubscription {
  id: string;
  user_id: string;
  plan_id: string;
  status: string;
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  current_period_start: string | null;
  current_period_end: string | null;
  cancel_at_period_end: boolean;
  created_at: string;
  updated_at: string;
  plan?: {
    id: string;
    name: string;
    slug: string;
    price_monthly: number | null;
    price_yearly: number | null;
    profile_limit: number;
    features: string[];
  };
}

interface SubscriptionResult {
  dbSubscription: UserSubscription | null;
  stripeData: {
    subscribed: boolean;
    price_id: string | null;
    subscription_end: string | null;
    cancel_at_period_end: boolean;
  } | null;
}

export function useSubscription() {
  const { user, session } = useAuth();
  const queryClient = useQueryClient();
  const { isSubscriber, isAdmin } = useUserRole();

  // Only run the query when we have both user and session
  const isReady = !!user?.id && !!session?.access_token;

  const { data, isLoading, refetch } = useQuery({
    queryKey: ["user-subscription", user?.id],
    queryFn: async (): Promise<SubscriptionResult & { stripeAuthError?: boolean; stripeUnavailable?: boolean }> => {
      // Double-check we have valid auth before proceeding
      if (!user?.id || !session?.access_token) {
        return { dbSubscription: null, stripeData: null, stripeAuthError: false, stripeUnavailable: false };
      }

      // Check Stripe directly for real-time status
      let stripeData = null;
      let stripeAuthError = false;
      let stripeUnavailable = false;
      
      try {
        const { data: stripeResponse, error: stripeError } = await supabase.functions.invoke("check-subscription");
        
        if (stripeError) {
          console.error("Stripe check error:", stripeError);
          // Check if it's an auth error (401)
          if (stripeError.message?.includes("401") || stripeError.message?.includes("Unauthorized") || stripeError.message?.includes("Auth")) {
            stripeAuthError = true;
          }
        } else if (stripeResponse?.stripe_unavailable) {
          stripeUnavailable = true;
        } else if (stripeResponse?.error) {
          console.error("Stripe response error:", stripeResponse.error);
          if (stripeResponse.error.includes("Auth") || stripeResponse.error.includes("Unauthorized")) {
            stripeAuthError = true;
          }
        } else if (stripeResponse && !stripeResponse.error) {
          stripeData = stripeResponse;
        }
      } catch (err) {
        console.error("Failed to check Stripe subscription:", err);
      }

      // Also check database for subscription record. 'past_due' counts as
      // subscribed alongside 'active' (C1, 2026-08-23 final review):
      // dunning is a payment-collection state, not an entitlement state,
      // and effective_user_quotas() now resolves the same population. The
      // ORDER BY + LIMIT 1 mirrors that SQL arbiter's own tie-break -
      // filtering on IN(...) instead of a single .eq() can return more than
      // one row, and .maybeSingle() throws on 2+ rows, which would make
      // this hook fall back to "unsubscribed" for exactly the user this
      // fix is meant to protect.
      const { data: subscriptionData, error: subError } = await supabase
        .from("user_subscriptions")
        .select("*")
        .eq("user_id", user.id)
        .in("status", ["active", "past_due"])
        .order("current_period_end", { ascending: false, nullsFirst: false })
        .order("created_at", { ascending: false })
        .order("id", { ascending: false })
        .limit(1)
        .maybeSingle();

      if (subError) {
        console.error("Error fetching subscription:", subError);
        return { dbSubscription: null, stripeData, stripeAuthError, stripeUnavailable };
      }

      if (!subscriptionData) return { dbSubscription: null, stripeData, stripeAuthError };

      // Fetch the plan details
      const { data: planData, error: planError } = await supabase
        .from("subscription_plans")
        .select("id, name, slug, price_monthly, price_yearly, profile_limit, features")
        .eq("id", subscriptionData.plan_id)
        .single();

      if (planError) {
        console.error("Error fetching plan:", planError);
        return { dbSubscription: subscriptionData as UserSubscription, stripeData, stripeAuthError, stripeUnavailable };
      }

      return {
        dbSubscription: {
          ...subscriptionData,
          plan: {
            ...planData,
            features: Array.isArray(planData.features) ? planData.features : [],
          },
        } as UserSubscription,
        stripeData,
        stripeAuthError,
        stripeUnavailable,
      };
    },
    enabled: isReady,
    staleTime: 60 * 1000, // 1 minute
    refetchInterval: isReady ? 60 * 1000 : false, // Only refetch when authenticated
  });

  // Refetch subscription status when window regains focus
  useEffect(() => {
    const handleFocus = () => {
      if (user?.id) {
        queryClient.invalidateQueries({ queryKey: ["user-subscription", user.id] });
      }
    };

    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [user?.id, queryClient]);

  const dbSubscription = data?.dbSubscription ?? null;
  const stripeData = data?.stripeData ?? null;
  const stripeAuthError = data?.stripeAuthError ?? false;
  const stripeUnavailable = data?.stripeUnavailable ?? false;

  // Determine subscription status - prefer Stripe data, fall back to database
  const isSubscribedViaStripe = stripeData?.subscribed === true;
  const isSubscribedViaDb =
    !!dbSubscription && (dbSubscription.status === "active" || dbSubscription.status === "past_due");
  // Also treat admin-assigned "subscriber" role as subscribed
  const isSubscribedViaRole = isSubscriber || isAdmin;
  const isSubscribed = isSubscribedViaStripe || isSubscribedViaDb || isSubscribedViaRole;

  // Determine plan from Stripe price_id or database
  let planSlug = "free";
  let planName = "Free";
  
  if (stripeData?.price_id && PRICE_TO_PLAN[stripeData.price_id]) {
    planSlug = PRICE_TO_PLAN[stripeData.price_id];
    planName = planSlug.charAt(0).toUpperCase() + planSlug.slice(1);
  } else if (dbSubscription?.plan?.slug) {
    planSlug = dbSubscription.plan.slug;
    planName = dbSubscription.plan.name;
  } else if (isAdmin) {
    planSlug = "business";
    planName = "Business";
  } else if (isSubscriber) {
    planSlug = "pro";
    planName = "Pro";
  }

  const isPro = planSlug === "pro" || planSlug === "business";
  const isBusiness = planSlug === "business";
  const isFree = !isSubscribed;

  return {
    subscription: dbSubscription,
    stripeData,
    stripeAuthError,
    stripeUnavailable,
    isLoading,
    isSubscribed,
    planName,
    planSlug,
    isPro,
    isBusiness,
    isFree,
    cancelAtPeriodEnd: stripeData?.cancel_at_period_end || dbSubscription?.cancel_at_period_end || false,
    subscriptionEnd: stripeData?.subscription_end || dbSubscription?.current_period_end,
    refetch,
  };
}
