import { Link } from "react-router-dom";
import { Logo } from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ArrowLeft } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Icon3D, GradientHeading, Reveal } from "@/components/fx";
import type { GradientKey, HeadingPreset } from "@/components/fx";

interface DocPageHeaderProps {
  isAuthenticated: boolean;
  /** Display name shown in breadcrumb + hero (e.g. "Instagram API") */
  title: string;
  subtitle: string;
  /** Themed Lucide icon */
  icon: LucideIcon;
  /** Postora gradient variant */
  variant: GradientKey;
  /** Heading text gradient preset */
  headingPreset: HeadingPreset;
  /** Tailwind classes for the small header crumb icon background gradient */
  crumbAccentClass?: string;
  /** Optional badges row */
  badges?: { label: string; icon?: LucideIcon }[];
  /** Header CTA gradient classes (e.g. "from-rose-500 via-pink-500 to-fuchsia-500") */
  ctaGradient?: string;
}

export function DocPageHeader({
  isAuthenticated,
  title,
  subtitle,
  icon: Icon,
  variant,
  headingPreset,
  crumbAccentClass,
  badges,
  ctaGradient = "from-violet-500 via-fuchsia-500 to-pink-500",
}: DocPageHeaderProps) {
  return (
    <>
      {/* Sticky header */}
      <header className="sticky top-0 z-50 border-b border-border/60 bg-background">
        <div className="container mx-auto px-6 h-16 flex items-center justify-between">
          <div className="flex items-center gap-3 min-w-0">
            <Link to="/"><Logo /></Link>
            <span className="text-muted-foreground/60">/</span>
            <Link to="/docs" className="text-sm text-muted-foreground hover:text-foreground transition-colors hidden sm:inline">Docs</Link>
            <span className="text-muted-foreground/60 hidden sm:inline">/</span>
            <Link to="/n8n" className="text-sm text-muted-foreground hover:text-foreground transition-colors">n8n</Link>
            <span className="text-muted-foreground/60">/</span>
            <span className="text-sm font-medium text-foreground truncate">
              {title}
            </span>
          </div>
          <div className="flex items-center gap-4 shrink-0">
            {isAuthenticated ? (
              <Link to="/dashboard">
                <Button>Dashboard</Button>
              </Link>
            ) : (
              <Link to="/auth">
                <Button>Get Started</Button>
              </Link>
            )}
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border/40">
        <div className="container relative mx-auto px-6 py-12 max-w-5xl">
          <Link to="/n8n" className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground mb-6 transition-colors">
            <ArrowLeft className="w-4 h-4" />
            Back to n8n Integration
          </Link>

          <Reveal>
            <div className="flex items-center gap-5 mb-4">
              <Icon3D icon={Icon} variant={variant} size="md" />
              <div className="min-w-0">
                <GradientHeading as="h1" preset={headingPreset} size="xl" className="mb-1">
                  {title}
                </GradientHeading>
                <p className="text-muted-foreground">{subtitle}</p>
              </div>
            </div>

            {badges && badges.length > 0 && (
              <div className="flex flex-wrap gap-2 mt-6">
                {badges.map(({ label, icon: BIcon }) => (
                  <Badge
                    key={label}
                    variant="secondary"
                    className="gap-1 bg-card border border-border/60"
                  >
                    {BIcon && <BIcon className="w-3 h-3" />}
                    {label}
                  </Badge>
                ))}
              </div>
            )}
          </Reveal>
        </div>
      </section>
    </>
  );
}

export default DocPageHeader;