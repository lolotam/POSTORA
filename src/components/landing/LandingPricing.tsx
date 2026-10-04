import { Link } from "react-router-dom";
import { Check, Zap, Sparkles, Building2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Reveal, GradientRingCard, Icon3D, GradientHeading, type GradientKey } from "@/components/fx";

interface LandingPlan {
  name: string;
  price: string;
  originalPrice?: string;
  period: string;
  description: string;
  features: string[];
  popular: boolean;
  cta: string;
  promoLabel?: string;
  variant: GradientKey;
  icon: typeof Zap;
}

const pricingPlans: LandingPlan[] = [
  {
    name: "Free",
    price: "$0",
    period: "forever",
    description: "Perfect for getting started",
    features: ["2 social profiles", "10 posts per month", "Basic analytics", "Community support"],
    popular: false,
    cta: "Get Started Free",
    variant: "sky",
    icon: Zap,
  },
  {
    name: "Pro",
    price: "$5",
    originalPrice: "$19",
    period: "per month",
    description: "For growing creators",
    features: ["10 social profiles", "Unlimited posts", "Advanced analytics", "Priority support", "AI caption generation", "Custom scheduling"],
    popular: true,
    cta: "Start Pro Trial",
    promoLabel: "🔥 Early Bird — First 100 Users",
    variant: "violet",
    icon: Sparkles,
  },
  {
    name: "Business",
    price: "$49",
    period: "per month",
    description: "For teams and agencies",
    features: ["Unlimited profiles", "Unlimited posts", "Team collaboration", "API access", "White-label options", "Dedicated account manager"],
    popular: false,
    cta: "Contact Sales",
    variant: "amber",
    icon: Building2,
  },
];

export default function LandingPricing() {
  return (
    <section id="pricing" className="relative z-10 container mx-auto px-6 pb-32 scroll-mt-20">
      <Reveal className="text-center mb-16">
        <GradientHeading preset="sky-violet-pink">Simple, Transparent Pricing</GradientHeading>
        <p className="mt-4 text-muted-foreground max-w-xl mx-auto">
          Choose the perfect plan for your needs. Start free and scale as you grow.
        </p>
      </Reveal>

      <div className="grid md:grid-cols-3 gap-6 max-w-5xl mx-auto">
        {pricingPlans.map((plan, index) => (
          <Reveal key={plan.name} delay={index * 120}>
            <GradientRingCard
              variant={plan.variant}
              ringIntensity={plan.popular ? "strong" : "normal"}
              className={plan.popular ? "lg:-translate-y-2" : ""}
              innerClassName="flex flex-col p-6 md:p-7"
            >
              {plan.popular && (
                <div className="absolute -top-3 start-1/2 -translate-x-1/2">
                  <span className="px-3 py-1 rounded-full text-white text-xs font-medium shadow-lg bg-neutral-900 dark:bg-neutral-800">
                    Most Popular
                  </span>
                </div>
              )}

              <div className="flex items-center gap-3 mb-5">
                <Icon3D icon={plan.icon} variant={plan.variant} size="md" />
                <div>
                  <h3 className="text-xl font-bold tracking-tight">{plan.name}</h3>
                  <p className="text-xs text-muted-foreground">{plan.description}</p>
                </div>
              </div>

              {plan.promoLabel && (
                <span className="inline-block mb-3 px-2 py-0.5 rounded-full bg-muted text-foreground text-xs font-semibold w-fit">
                  {plan.promoLabel}
                </span>
              )}

              <div className="flex items-baseline gap-1 mb-6">
                {plan.originalPrice && (
                  <span className="text-lg text-muted-foreground line-through me-1">{plan.originalPrice}</span>
                )}
                <span className="text-4xl font-bold tracking-tight">{plan.price}</span>
                <span className="text-muted-foreground text-sm">/{plan.period}</span>
              </div>

              <ul className="space-y-3 mb-6 flex-1">
                {plan.features.map((feature) => (
                  <li key={feature} className="flex items-center gap-2 text-sm">
                    <Check className="w-4 h-4 text-emerald-500 flex-shrink-0" />
                    <span>{feature}</span>
                  </li>
                ))}
              </ul>

              <Link to="/auth?mode=signup" className="block">
                <Button variant={plan.popular ? "gradient" : "outline"} className="w-full">
                  {plan.cta}
                </Button>
              </Link>
            </GradientRingCard>
          </Reveal>
        ))}
      </div>
    </section>
  );
}
