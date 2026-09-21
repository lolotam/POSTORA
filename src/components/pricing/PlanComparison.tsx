import { Check, Sparkles, ImagePlus, Hash } from "lucide-react";
import { SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { FREE_TIER_FALLBACK } from "@/hooks/useQuotas";

interface TierRateLimit {
  plan_slug: string;
  endpoint: string;
  max_requests_per_hour: number;
  max_requests_per_day: number;
}

interface PlanComparisonProps {
  plans: SubscriptionPlan[];
  tierLimits: TierRateLimit[];
}

export function PlanComparison({ plans, tierLimits }: PlanComparisonProps) {
  const getRateLimit = (planSlug: string, endpoint: string) =>
    tierLimits.find((t) => t.plan_slug === planSlug && t.endpoint === endpoint);

  const formatRateLimit = (limit: TierRateLimit | undefined) => {
    if (!limit) return "—";
    return `${limit.max_requests_per_hour}/hr, ${limit.max_requests_per_day}/day`;
  };

  const rows = [
    {
      label: "Social Profiles",
      render: (plan: SubscriptionPlan) =>
        plan.profile_limit === -1
          ? "Unlimited"
          // NULL falls back through effective_user_quotas() to the same
          // free-tier default used everywhere else.
          : String(plan.profile_limit ?? FREE_TIER_FALLBACK.max_profiles),
    },
    { label: "Scheduling", render: (plan: SubscriptionPlan) => plan.slug === "free" ? "Basic" : "Unlimited" },
    { label: "AI Caption Generation", icon: <Sparkles className="w-4 h-4" />, render: (plan: SubscriptionPlan) => formatRateLimit(getRateLimit(plan.slug, "generate-caption")) },
    { label: "AI Image Generation", icon: <ImagePlus className="w-4 h-4" />, render: (plan: SubscriptionPlan) => formatRateLimit(getRateLimit(plan.slug, "generate-image")) },
    { label: "AI Hashtag Generation", icon: <Hash className="w-4 h-4" />, render: (plan: SubscriptionPlan) => formatRateLimit(getRateLimit(plan.slug, "generate-hashtags")) },
    { label: "Analytics", render: (plan: SubscriptionPlan) => plan.slug === "free" ? <span className="text-muted-foreground">—</span> : <Check className="w-5 h-5 text-green-500 mx-auto" /> },
    { label: "API Access", render: (plan: SubscriptionPlan) => plan.slug === "business" ? <Check className="w-5 h-5 text-green-500 mx-auto" /> : <span className="text-muted-foreground">—</span> },
    { label: "Support", render: (plan: SubscriptionPlan) => plan.slug === "free" ? "Standard" : plan.slug === "pro" ? "Priority" : "Dedicated" },
  ];

  return (
    <div className="rounded-2xl border bg-card overflow-hidden">
      <div className="p-6 border-b">
        <h2 className="text-xl font-semibold">Compare Plans</h2>
        <p className="text-sm text-muted-foreground">See what's included in each plan</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b bg-muted/50">
              <th className="text-start p-4 font-medium">Feature</th>
              {plans.map((plan) => (
                <th key={plan.id} className="text-center p-4 font-medium">{plan.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i} className={i < rows.length - 1 ? "border-b" : ""}>
                <td className="p-4 text-muted-foreground">
                  {row.icon ? (
                    <div className="flex items-center gap-2">{row.icon}{row.label}</div>
                  ) : row.label}
                </td>
                {plans.map((plan) => (
                  <td key={plan.id} className="text-center p-4 text-sm">{row.render(plan)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
