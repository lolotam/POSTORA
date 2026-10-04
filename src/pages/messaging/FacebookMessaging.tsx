import { useTranslation } from "react-i18next";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { Facebook, Sparkles, ArrowRight } from "lucide-react";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate, Link } from "react-router-dom";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { Button } from "@/components/ui/button";

export default function FacebookMessaging() {
  const { t } = useTranslation("inbox");
  const { flags, isLoading } = useFeatureFlags();

  if (!isLoading && !flags.msgFacebook) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="group flex items-center gap-4">
              <Icon3D icon={Facebook} variant="sky" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="sky-violet" size="lg" as="h1">{t("facebook.title", "Facebook Messenger")}</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">{t("facebook.subtitle", "Manage your Facebook Messenger conversations")}</p>
              </div>
            </div>

            <Button asChild variant="outline" size="sm" className="gap-2 border-border hover:bg-muted">
              <Link to="/automation/agents?platform=facebook&surface=dms">
                <Sparkles className="w-4 h-4 text-foreground" />
                <span>{t("facebook.aiSettings", "AI & Automation Settings")}</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </Reveal>

        <GradientDivider tone="sky" />

        <Reveal delay={80}>
          <GradientRingCard variant="sky" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
            <MessagingInbox platform="facebook" />
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
