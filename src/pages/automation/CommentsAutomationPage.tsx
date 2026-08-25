import { Navigate, useSearchParams, Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { MessageCircle, Bot, Sparkles, ArrowRight, ShieldCheck } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

export type CommentPlatform = "facebook" | "instagram" | "threads";

interface PlatformOption {
  id: CommentPlatform;
  label: string;
  colorPreset: "sky" | "rose" | "violet";
  description: string;
}

const PLATFORMS: PlatformOption[] = [
  { id: "facebook", label: "Facebook", colorPreset: "sky", description: "Page post comment auto-replies, spam moderation, and auto-hide rules" },
  { id: "instagram", label: "Instagram", colorPreset: "rose", description: "IG Media comment triggers, comment-to-DM flows, and instant replies" },
  { id: "threads", label: "Threads", colorPreset: "violet", description: "Automated responses and sentiment monitoring for Threads replies" },
];

export default function CommentsAutomationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const platformParam = searchParams.get("platform") as CommentPlatform;
  const platform: CommentPlatform = PLATFORMS.some((p) => p.id === platformParam) ? platformParam : "facebook";
  const { flags, isLoading: flagsLoading } = useFeatureFlags();

  // Matches the guard CommentManagerPage already carries: comment automation is gated by
  // the same flag as the comment surface it configures.
  if (!flagsLoading && !flags.commentManager) {
    return <Navigate to="/dashboard" replace />;
  }

  const selectedPlatformMeta = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];

  const handlePlatformChange = (nextPlatform: CommentPlatform) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("platform", nextPlatform);
      return next;
    }, { replace: true });
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Icon3D icon={MessageCircle} variant="emerald" size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="emerald-cyan-sky" size="lg" as="h1">
                    Comments Automation
                  </GradientHeading>
                  <Badge variant="outline" className="border-emerald-500/30 text-emerald-400 bg-emerald-500/10 gap-1 text-xs">
                    <ShieldCheck className="w-3 h-3" /> Auto-Reply & Moderation
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Automate public post comment replies, sentiment-based routing, and spam filters
                </p>
              </div>
            </div>

            <Button asChild variant="outline" className="gap-2 border-primary/30 hover:bg-primary/10">
              <Link to={`/automation/agents?platform=${platform}&surface=comments`}>
                <Sparkles className="w-4 h-4 text-primary" />
                <span>Configure AI Comment Agent</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </Reveal>

        <GradientDivider tone="emerald" />

        {/* Platform Tabs Selector */}
        <Reveal delay={40}>
          <div className="flex flex-wrap items-center gap-2 bg-card/60 backdrop-blur-md border border-border/50 rounded-2xl p-2 shadow-sm" role="tablist" aria-label="Comment Platforms">
            {PLATFORMS.map((p) => {
              const isSelected = platform === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="tab"
                  aria-selected={isSelected}
                  onClick={() => handlePlatformChange(p.id)}
                  className={cn(
                    "flex items-center gap-2 py-2.5 px-4 rounded-xl border text-sm font-medium transition-all duration-200",
                    isSelected
                      ? "bg-primary/15 border-primary text-foreground shadow-sm ring-1 ring-primary/40 font-semibold"
                      : "bg-background/50 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                  )}
                >
                  <PlatformIcon platform={p.id} className="w-4 h-4 shrink-0" />
                  <span>{p.label}</span>
                </button>
              );
            })}
          </div>
        </Reveal>

        {/* Platform Info Banner */}
        <Reveal delay={60}>
          <div className="flex items-center justify-between px-4 py-3 rounded-xl bg-muted/40 border border-border/40 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <PlatformIcon platform={platform} className="w-4 h-4" />
              <span className="font-semibold text-foreground">{selectedPlatformMeta.label}:</span>
              <span>{selectedPlatformMeta.description}</span>
            </div>
            <Link to="/comments" className="text-primary hover:underline flex items-center gap-1">
              <span>Go to Comment Manager</span>
              <ArrowRight className="w-3 h-3" />
            </Link>
          </div>
        </Reveal>

        {/* Automation Handlers & Rules */}
        <Reveal delay={80}>
          <GradientRingCard
            variant={selectedPlatformMeta.colorPreset}
            padded={false}
            hoverLift={false}
            ringIntensity="subtle"
            innerClassName="p-4 md:p-6 space-y-6"
          >
            <AutomationHandlerCard platform={platform} />
            <AutoReplyManager platform={platform} />
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
