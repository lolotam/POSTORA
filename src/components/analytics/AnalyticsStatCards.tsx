import { useTranslation } from "react-i18next";
import { Send, CheckCircle2, Clock, XCircle } from "lucide-react";
import { Reveal, Icon3D, GradientRingCard, type GradientKey } from "@/components/fx";

interface AnalyticsStatCardsProps {
  totalPosts: number;
  publishedPosts: number;
  scheduledPosts: number;
  failedPosts: number;
}

export function AnalyticsStatCards({
  totalPosts,
  publishedPosts,
  scheduledPosts,
  failedPosts,
}: AnalyticsStatCardsProps) {
  const { t } = useTranslation("analytics");
  const items: { id: string; label: string; value: number; icon: typeof Send; variant: GradientKey }[] = [
    { id: "total", label: t("stats.totalPosts", "Total Posts"), value: totalPosts,     icon: Send,         variant: "sky" },
    { id: "published", label: t("stats.published", "Published"),   value: publishedPosts, icon: CheckCircle2, variant: "emerald" },
    { id: "scheduled", label: t("stats.scheduled", "Scheduled"),   value: scheduledPosts, icon: Clock,        variant: "amber" },
    { id: "failed", label: t("common:status.failed", "Failed"),      value: failedPosts,    icon: XCircle,      variant: "rose" },
  ];

  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
      {items.map((item, i) => (
        <Reveal key={item.id} delay={i * 90}>
          <GradientRingCard variant={item.variant} innerClassName="p-4 sm:p-5">
            <div className="flex items-center gap-3 sm:gap-4">
              <Icon3D icon={item.icon} variant={item.variant} size="sm" />
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{item.label}</p>
                <p className="text-2xl font-bold tracking-tight">{item.value}</p>
              </div>
            </div>
          </GradientRingCard>
        </Reveal>
      ))}
    </div>
  );
}
