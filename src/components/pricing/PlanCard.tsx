import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Loader2, Check, Zap, Sparkles, Building2 } from "lucide-react";
import { SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { FREE_TIER_FALLBACK } from "@/hooks/useQuotas";
import { GradientRingCard, Icon3D, type GradientKey } from "@/components/fx";

const planIcons: Record<string, typeof Zap> = {
  free: Zap,
  pro: Sparkles,
  business: Building2,
};

const planVariants: Record<string, GradientKey> = {
  free: "tiktok",
  pro: "tiktok",
  business: "tiktok",
};

interface PlanCardProps {
  plan: SubscriptionPlan;
  isYearly: boolean;
  isAdmin: boolean;
  planSlug: string | null;
  isSubscribed: boolean;
  loadingPlanId: string | null;
  onSelect: (plan: SubscriptionPlan) => void;
}

export function PlanCard({ plan, isYearly, isAdmin, planSlug, isSubscribed, loadingPlanId, onSelect }: PlanCardProps) {
  const formatPrice = () => {
    const price = isYearly ? plan.price_yearly : plan.price_monthly;
    if (!price || price === 0) return "Free";
    return `$${price.toFixed(2)}`;
  };

  const getPriceLabel = () => {
    if (!plan.price_monthly || plan.price_monthly === 0) return "forever";
    return isYearly ? "/year" : "/month";
  };

  const getYearlySavings = () => {
    if (!plan.price_monthly || !plan.price_yearly) return null;
    const yearlyMonthly = plan.price_monthly * 12;
    const savings = yearlyMonthly - plan.price_yearly;
    if (savings <= 0) return null;
    return `Save ${Math.round((savings / yearlyMonthly) * 100)}%`;
  };

  const variant = planVariants[plan.slug] ?? "sky";
  const Icon = planIcons[plan.slug] ?? Zap;

  return (
    <GradientRingCard
      variant={variant}
      ringIntensity={plan.is_popular ? "strong" : "normal"}
      className={plan.is_popular ? "lg:-translate-y-2" : ""}
      innerClassName="flex flex-col p-6 md:p-7"
    >
      {plan.is_popular && (
        <Badge className="absolute -top-3 start-1/2 -translate-x-1/2 bg-tiktok-red text-white border-0 shadow-lg shadow-tiktok-red/30">
          Most Popular
        </Badge>
      )}

      <div className="space-y-4">
        <div className="flex items-center gap-3">
          <Icon3D icon={Icon} variant={variant} size="md" />
          <div>
            <h3 className="text-xl font-bold tracking-tight">{plan.name}</h3>
            <p className="text-sm text-muted-foreground">
              {plan.profile_limit === -1
                ? "Unlimited profiles"
                // NULL falls back through effective_user_quotas() to the
                // same free-tier default used everywhere else — never a
                // second hardcoded literal here.
                : `Up to ${plan.profile_limit ?? FREE_TIER_FALLBACK.max_profiles} profiles`}
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <div className="flex items-baseline gap-1">
            <span className="text-4xl font-bold tracking-tight">{formatPrice()}</span>
            <span className="text-muted-foreground">{getPriceLabel()}</span>
          </div>
          {isYearly && getYearlySavings() && (
            <Badge variant="secondary" className="bg-tiktok-cyan/25 text-foreground border-tiktok-cyan">
              {getYearlySavings()}
            </Badge>
          )}
        </div>
      </div>

      <ul className="mt-6 space-y-3 flex-1">
        {plan.features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2">
            <Check className="w-5 h-5 text-tiktok-red shrink-0 mt-0.5" />
            <span className="text-sm">{feature}</span>
          </li>
        ))}
      </ul>

      {isAdmin && plan.slug !== "free" && plan.slug !== planSlug ? (
        <div className="mt-6 space-y-2">
          <div className="w-full rounded-md border border-tiktok-cyan bg-tiktok-cyan/10 px-3 py-2 text-center">
            <Badge variant="secondary" className="bg-tiktok-cyan/25 text-foreground border-tiktok-cyan">
              Admin — full access
            </Badge>
          </div>
          <p className="text-xs text-muted-foreground text-center">
            To test checkout, sign in with a non-admin test account.
          </p>
          <p className="text-xs text-center">
            <a href="/admin/plans" className="text-primary hover:underline">
              Manage subscription plans
            </a>
          </p>
        </div>
      ) : (
        <Button
          className="mt-6 w-full"
          variant={plan.is_popular ? "default" : "outline"}
          onClick={() => onSelect(plan)}
          disabled={plan.slug === planSlug || loadingPlanId === plan.id}
        >
          {loadingPlanId === plan.id ? (
            <>
              <Loader2 className="w-4 h-4 me-2 animate-spin" />
              Processing...
            </>
          ) : plan.slug === planSlug ? (
            "Current Plan"
          ) : plan.slug === "free" ? (
            isSubscribed ? "Downgrade" : "Current Plan"
          ) : (
            "Upgrade Now"
          )}
        </Button>
      )}
    </GradientRingCard>
  );
}
