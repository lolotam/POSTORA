import { LucideIcon, Loader2 } from "lucide-react";
import { Reveal, Icon3D, GradientRingCard, type GradientKey } from "@/components/fx";

interface StatCardData {
  id?: string;
  label: string;
  value: string;
  icon: LucideIcon;
  trend?: string | null;
  variant?: GradientKey;
}

interface StatCardsProps {
  stats: StatCardData[];
  isLoading?: boolean;
}

const DEFAULT_VARIANTS: GradientKey[] = ["sky", "violet", "emerald", "amber", "rose", "indigo", "cyan"];

export function StatCards({ stats, isLoading }: StatCardsProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
      {stats.map((stat, i) => {
        const variant = stat.variant ?? DEFAULT_VARIANTS[i % DEFAULT_VARIANTS.length];
        return (
          <Reveal key={stat.id ?? stat.label} delay={i * 90}>
            <GradientRingCard variant={variant} innerClassName="p-5 md:p-5">
              <div className="flex items-center justify-between mb-3">
                <Icon3D icon={stat.icon} variant={variant} size="sm" />
                {isLoading && (
                  <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                )}
              </div>
              <p className="text-2xl font-bold tracking-tight">{stat.value}</p>
              <p className="text-sm text-muted-foreground">{stat.label}</p>
            </GradientRingCard>
          </Reveal>
        );
      })}
    </div>
  );
}
