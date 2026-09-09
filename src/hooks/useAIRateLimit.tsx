import { useState, useEffect, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "./useAuth";
import { ENTITLED_SUBSCRIPTION_STATUSES } from "@/lib/subscriptionStatus";

interface RateLimitState {
  limitPerHour: number;
  limitPerDay: number;
  remainingHour: number;
  remainingDay: number;
  resetTimeHour: Date | null;
  resetTimeDay: Date | null;
  planSlug: string;
}

interface TierLimit {
  plan_slug: string;
  endpoint: string;
  max_requests_per_hour: number;
  max_requests_per_day: number;
  is_active: boolean;
}

interface UseAIRateLimitReturn {
  captionLimit: RateLimitState;
  imageLimit: RateLimitState;
  hashtagLimit: RateLimitState;
  updateFromHeaders: (endpoint: "caption" | "image" | "hashtag", headers: Headers) => void;
  refreshLimits: () => Promise<void>;
  isLoading: boolean;
}

const DEFAULT_STATE: RateLimitState = {
  limitPerHour: 0,
  limitPerDay: 0,
  remainingHour: 0,
  remainingDay: 0,
  resetTimeHour: null,
  resetTimeDay: null,
  planSlug: "free",
};

export function useAIRateLimit(): UseAIRateLimitReturn {
  const { user } = useAuth();
  const [captionLimit, setCaptionLimit] = useState<RateLimitState>(DEFAULT_STATE);
  const [imageLimit, setImageLimit] = useState<RateLimitState>(DEFAULT_STATE);
  const [hashtagLimit, setHashtagLimit] = useState<RateLimitState>(DEFAULT_STATE);
  const [isLoading, setIsLoading] = useState(true);

  const updateFromHeaders = useCallback((endpoint: "caption" | "image" | "hashtag", headers: Headers) => {
    const limitHour = parseInt(headers.get("X-RateLimit-Limit-Hour") || headers.get("X-RateLimit-Limit") || "0", 10);
    const limitDay = parseInt(headers.get("X-RateLimit-Limit-Day") || "0", 10);
    const remainingHour = parseInt(headers.get("X-RateLimit-Remaining-Hour") || headers.get("X-RateLimit-Remaining") || "0", 10);
    const remainingDay = parseInt(headers.get("X-RateLimit-Remaining-Day") || "0", 10);
    const retryAfter = parseInt(headers.get("Retry-After") || "0", 10);
    
    const setter = endpoint === "caption" ? setCaptionLimit : endpoint === "image" ? setImageLimit : setHashtagLimit;
    
    setter((prev) => ({
      ...prev,
      limitPerHour: limitHour || prev.limitPerHour,
      limitPerDay: limitDay || prev.limitPerDay,
      remainingHour,
      remainingDay,
      resetTimeHour: retryAfter > 0 ? new Date(Date.now() + retryAfter * 1000) : prev.resetTimeHour,
    }));
  }, []);

  const refreshLimits = useCallback(async () => {
    if (!user) {
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      // Get user's subscription plan. F5 (CodeRabbit round 1): "active"
      // alone silently rate-limited a dunning (past_due) customer to
      // Free-tier AI usage while their card was just being retried -
      // effective_user_quotas() still entitles them for that window.
      const { data: subscription } = await supabase
        .from("user_subscriptions")
        .select(`
          plan_id,
          status,
          subscription_plans!inner (slug)
        `)
        .eq("user_id", user.id)
        .in("status", ENTITLED_SUBSCRIPTION_STATUSES)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();

      const planSlug = subscription?.subscription_plans?.slug || "free";

      // Fetch tier-based limits for the user's plan
      const { data: tierLimits, error: tierError } = await supabase
        .from("tier_rate_limits")
        .select("*")
        .eq("plan_slug", planSlug)
        .eq("is_active", true);

      if (tierError) {
        console.error("Failed to fetch tier limits:", tierError);
      }

      // Fetch user-specific overrides
      const { data: userOverrides, error: overridesError } = await supabase
        .from("user_rate_limits")
        .select("endpoint, max_requests, window_minutes, expires_at")
        .eq("user_id", user.id);

      if (overridesError) {
        console.error("Failed to fetch user overrides:", overridesError);
      }

      // Create a map of tier limits
      const tierLimitMap = new Map<string, TierLimit>();
      tierLimits?.forEach((tier) => {
        tierLimitMap.set(tier.endpoint, tier);
      });

      // Create effective limits (user override > tier limit)
      const now = new Date();
      const getEffectiveLimits = (endpoint: string) => {
        // Check for user override first
        const override = userOverrides?.find((o) => 
          o.endpoint === endpoint && 
          (!o.expires_at || new Date(o.expires_at) > now)
        );

        if (override) {
          // User override uses max_requests for both hourly (window_minutes determines)
          const isHourly = override.window_minutes <= 60;
          return {
            maxPerHour: isHourly ? override.max_requests : Math.ceil(override.max_requests / 24),
            maxPerDay: isHourly ? override.max_requests * 24 : override.max_requests,
          };
        }

        // Fall back to tier limits
        const tier = tierLimitMap.get(endpoint);
        if (tier) {
          return {
            maxPerHour: tier.max_requests_per_hour,
            maxPerDay: tier.max_requests_per_day,
          };
        }

        // Default fallback
        const defaults: Record<string, { maxPerHour: number; maxPerDay: number }> = {
          "generate-caption": { maxPerHour: 5, maxPerDay: 20 },
          "generate-image": { maxPerHour: 2, maxPerDay: 10 },
          "generate-hashtags": { maxPerHour: 10, maxPerDay: 30 },
        };
        return defaults[endpoint] || { maxPerHour: 5, maxPerDay: 20 };
      };

      const captionLimits = getEffectiveLimits("generate-caption");
      const imageLimits = getEffectiveLimits("generate-image");
      const hashtagLimits = getEffectiveLimits("generate-hashtags");

      // Fetch all six api_logs counts (3 endpoints × hour/day) in a single RPC
      // to avoid the N+1 pattern of firing one query per endpoint per window.
      const { data: counts, error: countsError } = await supabase
        .rpc("get_ai_rate_limit_counts")
        .single();

      if (countsError) {
        console.error("Failed to fetch AI rate limit counts:", countsError);
      }

      const captionHour  = counts?.caption_hour  ?? 0;
      const captionDay   = counts?.caption_day   ?? 0;
      const imageHour    = counts?.image_hour    ?? 0;
      const imageDay     = counts?.image_day     ?? 0;
      const hashtagHour  = counts?.hashtag_hour  ?? 0;
      const hashtagDay   = counts?.hashtag_day   ?? 0;

      setCaptionLimit({
        limitPerHour: captionLimits.maxPerHour,
        limitPerDay: captionLimits.maxPerDay,
        remainingHour: Math.max(0, captionLimits.maxPerHour - captionHour),
        remainingDay: Math.max(0, captionLimits.maxPerDay - captionDay),
        resetTimeHour: null,
        resetTimeDay: null,
        planSlug,
      });

      setImageLimit({
        limitPerHour: imageLimits.maxPerHour,
        limitPerDay: imageLimits.maxPerDay,
        remainingHour: Math.max(0, imageLimits.maxPerHour - imageHour),
        remainingDay: Math.max(0, imageLimits.maxPerDay - imageDay),
        resetTimeHour: null,
        resetTimeDay: null,
        planSlug,
      });

      setHashtagLimit({
        limitPerHour: hashtagLimits.maxPerHour,
        limitPerDay: hashtagLimits.maxPerDay,
        remainingHour: Math.max(0, hashtagLimits.maxPerHour - hashtagHour),
        remainingDay: Math.max(0, hashtagLimits.maxPerDay - hashtagDay),
        resetTimeHour: null,
        resetTimeDay: null,
        planSlug,
      });
    } catch (err) {
      console.error("Error refreshing rate limits:", err);
    } finally {
      setIsLoading(false);
    }
  }, [user]);

  // Initial load
  useEffect(() => {
    refreshLimits();
  }, [refreshLimits]);

  // Auto-refresh every minute
  useEffect(() => {
    const interval = setInterval(refreshLimits, 60 * 1000);
    return () => clearInterval(interval);
  }, [refreshLimits]);

  return {
    captionLimit,
    imageLimit,
    hashtagLimit,
    updateFromHeaders,
    refreshLimits,
    isLoading,
  };
}
