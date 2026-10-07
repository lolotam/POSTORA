import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation, Trans } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { useSubscriptionPlans, SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { useSubscription } from "@/hooks/useSubscription";
import { useAuth } from "@/hooks/useAuth";
import { useUserRole } from "@/hooks/useUserRole";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { PlanCard } from "@/components/pricing/PlanCard";
import { PlanComparison } from "@/components/pricing/PlanComparison";
import { AiCreditsSection } from "@/components/pricing/AiCreditsSection";
import { CouponInput } from "@/components/pricing/CouponInput";
import { PromotionBanner } from "@/components/pricing/PromotionBanner";
import { BlobHero, GradientHeading, Reveal, GradientDivider } from "@/components/fx";

interface TierRateLimit {
  plan_slug: string;
  endpoint: string;
  max_requests_per_hour: number;
  max_requests_per_day: number;
}

export default function Pricing() {
  const { t } = useTranslation("billing");
  const [isYearly, setIsYearly] = useState(false);
  const [loadingPlanId, setLoadingPlanId] = useState<string | null>(null);
  const [couponCode, setCouponCode] = useState("");
  const [tierLimits, setTierLimits] = useState<TierRateLimit[]>([]);
  const { data: plans = [], isLoading } = useSubscriptionPlans();
  const { user } = useAuth();
  const { isAdmin } = useUserRole();
  const { planSlug, isSubscribed } = useSubscription();
  const { toast } = useToast();
  const navigate = useNavigate();

  useEffect(() => {
    async function fetchTierLimits() {
      const { data } = await supabase
        .from("tier_rate_limits")
        .select("plan_slug, endpoint, max_requests_per_hour, max_requests_per_day")
        .eq("is_active", true);
      if (data) setTierLimits(data);
    }
    fetchTierLimits();
  }, []);

  const handleSelectPlan = async (plan: SubscriptionPlan) => {
    if (!user) { navigate("/auth"); return; }
    if (plan.slug === "free") return;
    if (plan.slug === planSlug) {
      toast({ title: t("pricing.toast.alreadyTitle", "Already subscribed"), description: t("pricing.toast.alreadyDesc", "You're already on the {{name}} plan.", { name: plan.name }) });
      return;
    }

    setLoadingPlanId(plan.id);
    const checkoutWindow = window.open("about:blank", "_blank");

    try {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session?.access_token) throw new Error(t("pricing.errors.pleaseLogIn", "Please log in to subscribe"));

      const referralCode = localStorage.getItem("referral_code");
      const response = await supabase.functions.invoke("stripe-checkout", {
        body: { plan_id: plan.id, price_type: isYearly ? "yearly" : "monthly", coupon_code: couponCode.trim() || undefined, referral_code: referralCode || undefined },
      });

      if (response.error) throw new Error(response.error.message || t("pricing.errors.createCheckout", "Failed to create checkout session"));

      if (response.data?.discount_applied) {
        toast({
          title: t("pricing.toast.couponApplied", "Coupon applied!"),
          description: response.data.discount_percent
            ? t("pricing.toast.percentDiscount", "{{percent}}% discount applied", { percent: response.data.discount_percent })
            : t("pricing.toast.amountDiscount", "${{amount}} discount applied", { amount: response.data.discount_amount }),
        });
      }

      const { url } = response.data;
      if (!url) throw new Error(t("pricing.errors.noCheckoutUrl", "No checkout URL returned"));

      if (checkoutWindow) { checkoutWindow.location.href = url; checkoutWindow.focus(); }
      else { window.location.href = url; }
    } catch (error) {
      if (checkoutWindow) checkoutWindow.close();
      console.error("Checkout error:", error);
      toast({ title: t("pricing.toast.checkoutFailed", "Checkout failed"), description: error instanceof Error ? error.message : t("pricing.toast.startCheckoutFailed", "Failed to start checkout"), variant: "destructive" });
    } finally {
      setLoadingPlanId(null);
    }
  };

  if (isLoading) {
    return (
      <DashboardLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
        </div>
      </DashboardLayout>
    );
  }

  return (
    <DashboardLayout>
      <div className="max-w-6xl mx-auto space-y-12">
        {/* Hero Section */}
        <section className="relative overflow-hidden rounded-3xl py-12 md:py-16 px-6 text-center">
          <BlobHero preset="tiktok" />
          <Reveal>
            <Badge variant="secondary" className="mb-4">{t("pricing.header.badge", "Pricing")}</Badge>
            <GradientHeading as="h1" preset="tiktok" size="2xl">
              {t("pricing.header.title", "Choose Your Plan")}
            </GradientHeading>
            <p className="mt-4 text-lg text-muted-foreground max-w-2xl mx-auto">
              {t("pricing.header.subtitle", "Start for free, upgrade when you're ready. All plans include our core features.")}
            </p>
          </Reveal>

          <div className="flex items-center justify-center gap-4 pt-6 relative">
            <Label htmlFor="billing-toggle" className={!isYearly ? "font-semibold" : "text-muted-foreground"}>{t("pricing.billing.monthly", "Monthly")}</Label>
            <Switch id="billing-toggle" checked={isYearly} onCheckedChange={setIsYearly} />
            <div className="flex items-center gap-2">
              <Label htmlFor="billing-toggle" className={isYearly ? "font-semibold" : "text-muted-foreground"}>{t("pricing.billing.yearly", "Yearly")}</Label>
              <Badge variant="default" className="bg-tiktok-cyan/25 text-foreground border-tiktok-cyan">{t("pricing.billing.saveUpTo", "Save up to 17%")}</Badge>
            </div>
          </div>

          <div className="flex items-center justify-center gap-2 pt-4 relative">
            <CouponInput couponCode={couponCode} setCouponCode={setCouponCode} />
          </div>
        </section>

        {/* Promotion Banner */}
        <PromotionBanner />

        <GradientDivider tone="primary" />

        {/* Pricing Cards */}
        <div className="grid md:grid-cols-3 gap-6">
          {plans.map((plan, i) => (
            <Reveal key={plan.id} delay={i * 120}>
              <PlanCard
                plan={plan}
                isYearly={isYearly}
                isAdmin={isAdmin}
                planSlug={planSlug}
                isSubscribed={isSubscribed}
                loadingPlanId={loadingPlanId}
                onSelect={handleSelectPlan}
              />
            </Reveal>
          ))}
        </div>

        <PlanComparison plans={plans} tierLimits={tierLimits} />
        <AiCreditsSection />

        <div className="text-center py-8">
          <p className="text-muted-foreground">
            <Trans
              ns="billing"
              i18nKey="pricing.footer.questions"
              defaults="Have questions? <docs>Check our documentation</docs> or <support>contact support</support>"
              components={{
                docs: <a href="https://postora.cloud/docs" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline" />,
                support: <a href="mailto:support@postora.cloud" className="text-primary hover:underline" />,
              }}
            />
          </p>
        </div>
      </div>
    </DashboardLayout>
  );
}
