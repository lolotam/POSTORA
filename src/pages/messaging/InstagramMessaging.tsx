import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { MessagingInbox } from "@/components/messaging/MessagingInbox";
import { Camera, Sparkles, ArrowRight } from "lucide-react";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { Navigate, Link } from "react-router-dom";
import { Icon3D, GradientHeading, GradientRingCard, GradientDivider, Reveal } from "@/components/fx";
import { Button } from "@/components/ui/button";

export default function InstagramMessaging() {
  const { flags, isLoading } = useFeatureFlags();

  if (!isLoading && !flags.msgInstagram) {
    return <Navigate to="/dashboard" replace />;
  }

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
            <div className="group flex items-center gap-4">
              <Icon3D icon={Camera} variant="rose" size="md" />
              <div className="flex-1 min-w-0">
                <GradientHeading preset="amber-rose-violet" size="lg" as="h1">Instagram DMs</GradientHeading>
                <p className="text-sm text-muted-foreground mt-1">Manage your Instagram Direct Messages</p>
              </div>
            </div>

            <Button asChild variant="outline" size="sm" className="gap-2 border-rose-500/30 hover:bg-rose-500/10">
              <Link to="/automation/agents?platform=instagram&surface=dms">
                <Sparkles className="w-4 h-4 text-rose-400" />
                <span>AI & Automation Settings</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </Reveal>

        <GradientDivider tone="rose" />

        <Reveal delay={80}>
          <GradientRingCard variant="rose" padded={false} hoverLift={false} ringIntensity="subtle" innerClassName="p-4 md:p-5">
            <MessagingInbox platform="instagram" />
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}

