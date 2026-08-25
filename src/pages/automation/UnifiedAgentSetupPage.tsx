import { Navigate, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { AI_AGENT_TABS, AiAgentManager, type AiAgentTab } from "@/components/messaging/AiAgentManager";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { Bot, MessageSquare, MessageCircle, Sparkles, CheckCircle2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";

interface PlatformOption {
  id: AiAgentPlatform;
  label: string;
  supportsComments: boolean;
  colorPreset: "emerald" | "sky" | "rose" | "violet";
}

const PLATFORMS: PlatformOption[] = [
  { id: "whatsapp", label: "WhatsApp", supportsComments: false, colorPreset: "emerald" },
  { id: "facebook", label: "Facebook", supportsComments: true, colorPreset: "sky" },
  { id: "instagram", label: "Instagram", supportsComments: true, colorPreset: "rose" },
  { id: "threads", label: "Threads", supportsComments: true, colorPreset: "violet" },
];

export type AgentSurface = "dms" | "comments";

const PLATFORM_FLAG: Record<AiAgentPlatform, keyof ReturnType<typeof useFeatureFlags>["flags"]> = {
  whatsapp: "msgWhatsapp",
  facebook: "msgFacebook",
  instagram: "msgInstagram",
  threads: "msgThreads",
};

export default function UnifiedAgentSetupPage() {
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

  const surfaceParam = searchParams.get("surface") as AgentSurface;
  const surface: AgentSurface = surfaceParam === "comments" && selectedPlatformMeta.supportsComments ? "comments" : "dms";

  const tabParam = searchParams.get("tab") as AiAgentTab;
  const activeTab: AiAgentTab = AI_AGENT_TABS.includes(tabParam) ? tabParam : "settings";

  const handlePlatformChange = (nextPlatform: AiAgentPlatform) => {
    const targetMeta = PLATFORMS.find((p) => p.id === nextPlatform);
    const nextSurface = surface === "comments" && targetMeta?.supportsComments ? "comments" : "dms";
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("platform", nextPlatform);
      next.set("surface", nextSurface);
      return next;
    }, { replace: true });
  };

  const handleSurfaceChange = (nextSurface: AgentSurface) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("surface", nextSurface);
      return next;
    }, { replace: true });
  };

  const handleTabChange = (nextTab: AiAgentTab) => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("tab", nextTab);
      return next;
    }, { replace: true });
  };

  return (
    <DashboardLayout>
      <div className="w-full space-y-6">
        <Reveal>
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
            <div className="flex items-center gap-4">
              <Icon3D icon={Bot} variant="violet" size="md" />
              <div>
                <div className="flex items-center gap-2">
                  <GradientHeading preset="violet-sky" size="lg" as="h1">
                    Agent Setup Portal
                  </GradientHeading>
                  <Badge variant="outline" className="border-violet-500/30 text-violet-400 bg-violet-500/10 gap-1 text-xs">
                    <Sparkles className="w-3 h-3" /> Unified AI Studio
                  </Badge>
                </div>
                <p className="text-sm text-muted-foreground mt-1">
                  Configure AI assistants, prompts, knowledge bases, and tools across all social channels
                </p>
              </div>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="violet" />

        {/* Platform & Surface Selectors Bar */}
        <Reveal delay={40}>
          <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 items-center bg-card/60 backdrop-blur-md border border-border/50 rounded-2xl p-3 md:p-4 shadow-sm">
            {/* Target Platform Selector */}
            <div className="lg:col-span-7 space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground ml-1">
                1. Target Social Channel
              </label>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2" role="tablist" aria-label="Social Channels">
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
                        "relative flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-sm font-medium transition-all duration-200",
                        isSelected
                          ? "bg-primary/15 border-primary text-foreground shadow-sm ring-1 ring-primary/40 font-semibold"
                          : "bg-background/50 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                      )}
                    >
                      <PlatformIcon platform={p.id} className="w-4 h-4 shrink-0" />
                      <span>{p.label}</span>
                      {isSelected && (
                        <CheckCircle2 className="w-3.5 h-3.5 text-primary absolute top-1.5 right-1.5" />
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Target Surface Selector (DMs vs Comments) */}
            <div className="lg:col-span-5 space-y-1.5">
              <label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground ml-1">
                2. Surfaces This Agent Answers
              </label>
              {/* Indicators, not a selector. There is one ai_agent_config per PLATFORM --
                  useAiAgentConfig keys on platform alone and ai_get_config/ai_upsert_config
                  take no surface -- so the same prompt, model and caps answer both DMs and
                  comments. These were tabs until 2026-08-25, which meant picking "Post
                  Comments" and editing silently overwrote the DM agent while the banner
                  claimed otherwise. Make them selectable again only alongside a real
                  per-surface config on the backend. */}
              <div className="grid grid-cols-2 gap-2" aria-label="Surfaces this agent answers">
                <div className="flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border border-primary/40 bg-primary/10 text-sm font-medium text-foreground">
                  <MessageSquare className="w-4 h-4 text-sky-400" />
                  <span>Direct Messages</span>
                </div>

                <div
                  className={cn(
                    "flex items-center justify-center gap-2 py-2.5 px-3 rounded-xl border text-sm font-medium",
                    selectedPlatformMeta.supportsComments
                      ? "border-primary/40 bg-primary/10 text-foreground"
                      : "border-border/30 bg-muted/20 text-muted-foreground opacity-60",
                  )}
                  title={selectedPlatformMeta.supportsComments
                    ? undefined
                    : `${selectedPlatformMeta.label} has no comment surface`}
                >
                  <MessageCircle className="w-4 h-4 text-emerald-400" />
                  <span>Post Comments</span>
                </div>
              </div>
            </div>
          </div>
        </Reveal>

        {/* Selected Context Banner */}
        <Reveal delay={60}>
          <div className="flex items-center justify-between px-3 py-2 rounded-lg bg-muted/40 border border-border/40 text-xs text-muted-foreground">
            <div className="flex items-center gap-2">
              <span>Editing configuration for:</span>
              <Badge variant="secondary" className="font-medium gap-1 text-foreground">
                <PlatformIcon platform={platform} className="w-3.5 h-3.5" />
                {selectedPlatformMeta.label}
              </Badge>
              <span>•</span>
              <Badge variant="secondary" className="font-medium text-foreground">
                Direct Messages and Post Comments
              </Badge>
            </div>
            <span className="hidden sm:inline">One agent per channel, saved automatically</span>
          </div>
        </Reveal>

        {/* Unified Agent Studio */}
        <Reveal delay={80}>
          <GradientRingCard
            variant={selectedPlatformMeta.colorPreset}
            padded={false}
            hoverLift={false}
            ringIntensity="subtle"
            innerClassName="p-4 md:p-6"
          >
            <AiAgentManager
              key={platform}
              platform={platform}
              activeTab={activeTab}
              onTabChange={handleTabChange}
            />
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
