import { Navigate, useSearchParams, Link } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { MessageSquare, Bot, Sparkles, ArrowRight, Zap, Headphones } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

interface PlatformOption {
  id: AiAgentPlatform;
  label: string;
  colorPreset: "emerald" | "sky" | "rose" | "violet";
  description: string;
}

const PLATFORMS: PlatformOption[] = [
  { id: "whatsapp", label: "WhatsApp", colorPreset: "emerald", description: "Automated routing and instant replies for WhatsApp chats" },
  { id: "facebook", label: "Facebook", colorPreset: "sky", description: "Automated responses and triage for Facebook Messenger" },
  { id: "instagram", label: "Instagram", colorPreset: "rose", description: "DM automations, keyword triggers, and auto-replies" },
  { id: "threads", label: "Threads", colorPreset: "violet", description: "Automated handling for Threads replies and direct mentions" },
];

const PLATFORM_FLAG: Record<AiAgentPlatform, keyof ReturnType<typeof useFeatureFlags>["flags"]> = {
  whatsapp: "msgWhatsapp",
  facebook: "msgFacebook",
  instagram: "msgInstagram",
  threads: "msgThreads",
};

export default function MessagingAutomationPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const platformParam = searchParams.get("platform") as AiAgentPlatform;
  const platform: AiAgentPlatform = PLATFORMS.some((p) => p.id === platformParam) ? platformParam : "whatsapp";
  const { flags, isLoading: flagsLoading } = useFeatureFlags();

  // The pages this replaced redirected when their platform flag was off. Without the
  // same guard, /automation/... let anyone mutate handler and auto-reply config for a
  // platform the operator has disabled.
  if (!flagsLoading && !flags[PLATFORM_FLAG[platform]]) {
    return <Navigate to="/dashboard" replace />;
  }

  const selectedPlatformMeta = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];

  const handlePlatformChange = (nextPlatform: AiAgentPlatform) => {
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
              <Icon3D icon={MessageSquare} variant="sky" size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="sky-violet" size="lg" as="h1">
                    Messaging Automation
                  </GradientHeading>
                  <Badge variant="outline" className="border-sky-500/30 text-sky-400 bg-sky-500/10 gap-1 text-xs">
                    <Bot className="w-3 h-3" /> Inbound DM Rules
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Configure automation handlers, keyword triggers, and instant auto-replies for direct customer messaging
                </p>
              </div>
            </div>

            <Button asChild variant="outline" className="gap-2 border-primary/30 hover:bg-primary/10">
              <Link to={`/automation/agents?platform=${platform}&surface=dms`}>
                <Sparkles className="w-4 h-4 text-primary" />
                <span>Configure AI Agent</span>
                <ArrowRight className="w-4 h-4" />
              </Link>
            </Button>
          </div>
        </Reveal>

        <GradientDivider tone="sky" />

        {/* Platform Tabs Selector */}
        <Reveal delay={40}>
          <div className="flex flex-wrap items-center gap-2 bg-card/60 backdrop-blur-md border border-border/50 rounded-2xl p-2 shadow-sm">
            {PLATFORMS.map((p) => {
              const isSelected = platform === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
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
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 px-4 py-3 rounded-xl bg-muted/40 border border-border/40 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <PlatformIcon platform={platform} className="w-4 h-4" />
              <span className="font-semibold text-foreground">{selectedPlatformMeta.label}:</span>
              <span>{selectedPlatformMeta.description}</span>
            </div>
            {platform === "whatsapp" && (
              <div className="flex items-center gap-2">
                <Link to="/messaging/whatsapp/quick-replies" className="text-primary hover:underline flex items-center gap-1">
                  <Zap className="w-3.5 h-3.5" /> Quick Replies
                </Link>
                <span>•</span>
                <Link to="/human-agent" className="text-primary hover:underline flex items-center gap-1">
                  <Headphones className="w-3.5 h-3.5" /> Human Team
                </Link>
              </div>
            )}
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
            {platform !== "whatsapp" && <AutoReplyManager platform={platform} />}
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
