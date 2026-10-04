import { GradientRingCard, Icon3D } from "@/components/fx";
import type { GradientKey } from "@/components/fx/gradients";
import type { LucideIcon } from "lucide-react";

const VARIANTS: GradientKey[] = ["sky", "violet", "emerald", "amber"];

interface FeatureCard {
  icon: LucideIcon;
  title: string;
  desc: string;
}

interface IntroFeatureGridProps {
  features: ReadonlyArray<FeatureCard>;
}

export function IntroFeatureGrid({ features }: IntroFeatureGridProps) {
  return (
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4 mb-8">
      {features.map((f, i) => {
        const variant = VARIANTS[i % VARIANTS.length];
        return (
          <GradientRingCard key={i} variant={variant} ringIntensity="subtle" innerClassName="p-5">
            <div className="group flex flex-col items-start gap-3">
              <Icon3D icon={f.icon} variant={variant} size="sm" />
              <h3 className="font-semibold text-foreground">{f.title}</h3>
              <p className="text-sm text-muted-foreground">{f.desc}</p>
            </div>
          </GradientRingCard>
        );
      })}
    </div>
  );
}

export default IntroFeatureGrid;