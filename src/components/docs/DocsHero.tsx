import { BookOpen, type LucideIcon } from "lucide-react";
import { PlatformIcon, ExtendedPlatform } from "@/components/PlatformIcon";
import { GradientHeading, Icon3D, Reveal, GradientDivider } from "@/components/fx";
import type { GradientKey, HeadingPreset } from "@/components/fx/gradients";
import { GRADIENTS } from "@/components/fx/gradients";
import { cn } from "@/lib/utils";

interface DocsHeroProps {
  title: string;
  description: string;
  badge?: string;
  platforms?: ExtendedPlatform[];
  badgeIcon?: React.ReactNode;
  /** Color theme for the hero. Defaults to violet. */
  variant?: GradientKey;
  /** Gradient text preset for the title. Defaults based on variant. */
  headingPreset?: HeadingPreset;
  /** Optional 3D icon shown above the title. Defaults to BookOpen. */
  icon?: LucideIcon;
}

const PRESET_FOR_VARIANT: Record<GradientKey, HeadingPreset> = {
  sky: "sky-violet",
  violet: "sky-violet-pink",
  emerald: "emerald-cyan-sky",
  amber: "amber-rose-violet",
  rose: "amber-rose-violet",
  indigo: "violet-sky",
  cyan: "emerald-cyan-sky",
  tiktok: "tiktok",
};

export function DocsHero({
  title,
  description,
  badge,
  platforms,
  badgeIcon,
  variant = "violet",
  headingPreset,
  icon: HeroIcon = BookOpen,
}: DocsHeroProps) {
  const g = GRADIENTS[variant];
  const preset = headingPreset ?? PRESET_FOR_VARIANT[variant];

  return (
    <section className="relative border-b border-border/60 overflow-hidden">
      {/* Animated gradient backdrop */}
      <div
        aria-hidden
        className={cn(
          "pointer-events-none absolute inset-0 -z-10 opacity-40 blur-3xl",
          "bg-gradient-to-br",
          g.from,
          g.via,
          g.to,
        )}
      />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-background/40 via-background/70 to-background"
      />

      <Reveal>
        <div className="container mx-auto px-6 py-14 md:py-16 text-center">
          <div className="inline-flex items-center justify-center mb-5 group">
            <Icon3D icon={HeroIcon} variant={variant} size="md" />
          </div>

          {badge && (
            <div className="inline-flex items-center gap-2 px-4 py-1.5 rounded-full border border-border/60 bg-card/60 backdrop-blur-md shadow-sm mb-6">
              {badgeIcon || <BookOpen className={cn("w-4 h-4", g.ringText)} />}
              <span className="text-sm font-medium">{badge}</span>
            </div>
          )}

          <GradientHeading as="h1" preset={preset} size="2xl" className="mb-4">
            {title}
          </GradientHeading>

          <p className="text-base md:text-xl text-muted-foreground max-w-2xl mx-auto mb-8">
            {description}
          </p>

          {platforms && platforms.length > 0 && (
            <div className="inline-flex flex-wrap items-center justify-center gap-3 px-5 py-3 rounded-full border border-border/60 bg-card/60 backdrop-blur-md shadow-sm">
              {platforms.map((p) => (
                <PlatformIcon key={p} platform={p} size="md" />
              ))}
            </div>
          )}
        </div>
      </Reveal>

      <GradientDivider tone={variant === "amber" || variant === "rose" ? "rose" : variant === "emerald" || variant === "cyan" ? "emerald" : "violet"} />
    </section>
  );
}
