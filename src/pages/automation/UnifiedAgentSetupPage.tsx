import { useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { AI_AGENT_TABS, AiAgentManager, type AiAgentTab } from "@/components/messaging/AiAgentManager";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { Icon3D, GradientHeading, GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { Bot, MessageSquare, MessageCircle, Sparkles, CheckCircle2, ShieldCheck, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";

interface PlatformOption {
  id: AiAgentPlatform;
  label: string;
  supportsComments: boolean;
  colorPreset: "emerald" | "sky" | "rose" | "violet";
  description: string;
}

const PLATFORMS: PlatformOption[] = [
  { id: "whatsapp", label: "WhatsApp", supportsComments: false, colorPreset: "emerald", description: "Direct customer chats, broadcasts & automated catalogs" },
  { id: "facebook", label: "Facebook", supportsComments: true, colorPreset: "sky", description: "Messenger DMs and Page post comment automations" },
  { id: "instagram", label: "Instagram", supportsComments: true, colorPreset: "rose", description: "Direct Inbound messages and Reels/Post comment replies" },
  { id: "threads", label: "Threads", supportsComments: true, colorPreset: "violet", description: "Mentions, conversation threads and public replies" },
];

export type AgentSurfaceSelection = "dms" | "comments" | "both";

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

  if (!flagsLoading && !flags[PLATFORM_FLAG[platform]]) {
    return <Navigate to="/dashboard" replace />;
  }

  const selectedPlatformMeta = PLATFORMS.find((p) => p.id === platform) || PLATFORMS[0];

  const surfaceParam = searchParams.get("surface");
  let dmsActive = true;
  let commentsActive = selectedPlatformMeta.supportsComments;

  if (surfaceParam === "dms") {
    dmsActive = true;
    commentsActive = false;
  } else if (surfaceParam === "comments" && selectedPlatformMeta.supportsComments) {
    dmsActive = false;
    commentsActive = true;
  } else if (surfaceParam === "both" && selectedPlatformMeta.supportsComments) {
    dmsActive = true;
    commentsActive = true;
  } else {
    // Default: DMs active for all; comments active if supported
    dmsActive = true;
    commentsActive = selectedPlatformMeta.supportsComments;
  }

  const tabParam = searchParams.get("tab") as AiAgentTab;
  const activeTab: AiAgentTab = AI_AGENT_TABS.includes(tabParam) ? tabParam : "settings";

  const handlePlatformChange = (nextPlatform: AiAgentPlatform) => {
    const targetMeta = PLATFORMS.find((p) => p.id === nextPlatform);
    const nextCommentsActive = targetMeta?.supportsComments && commentsActive;
    let nextSurface: AgentSurfaceSelection = "dms";
    if (dmsActive && nextCommentsActive) nextSurface = "both";
    else if (!dmsActive && nextCommentsActive) nextSurface = "comments";

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("platform", nextPlatform);
      next.set("surface", nextSurface);
      return next;
    }, { replace: true });
  };

  const handleToggleDms = () => {
    // Prevent unchecking if comments are disabled or not supported
    if (dmsActive && !commentsActive) return;
    const nextDms = !dmsActive;
    const nextComments = commentsActive;

    let nextSurface: AgentSurfaceSelection = "dms";
    if (nextDms && nextComments) nextSurface = "both";
    else if (nextComments) nextSurface = "comments";

    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("surface", nextSurface);
      return next;
    }, { replace: true });
  };

  const handleToggleComments = () => {
    if (!selectedPlatformMeta.supportsComments) return;
    if (commentsActive && !dmsActive) return;
    const nextComments = !commentsActive;
    const nextDms = dmsActive;

    let nextSurface: AgentSurfaceSelection = "dms";
    if (nextDms && nextComments) nextSurface = "both";
    else if (nextDms) nextSurface = "dms";
    else nextSurface = "comments";

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
      <div className="w-full space-y-6 pb-12">
        {/* Header (Left-aligned as before) */}
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
                  Configure intelligent AI assistants, knowledge bases, database connectors, and automations across all social channels
                </p>
              </div>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="violet" />

        {/* Centered Large 3D Glossy Platform Cards */}
        <Reveal delay={30}>
          <div className="flex flex-col items-center space-y-5 py-6">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Select Social Channel
            </span>
            <div className="flex items-center justify-center gap-8 sm:gap-10 md:gap-14 flex-wrap" role="tablist" aria-label="Social Channels">
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
                      "flex flex-col items-center gap-4 flex-shrink-0 transition-all duration-300 hover:scale-105 hover:-translate-y-2.5 cursor-pointer group focus:outline-none",
                    )}
                  >
                    <div
                      className={cn(
                        "relative w-28 h-28 sm:w-36 sm:h-36 md:w-40 md:h-40 rounded-[2rem] backdrop-blur-2xl flex items-center justify-center border transition-all duration-300 overflow-visible",
                        // Ultra glossy 3D glass refraction and specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-[2rem] before:bg-gradient-to-b before:from-white/40 before:via-white/15 before:to-transparent before:pointer-events-none",
                        isSelected
                          ? "bg-gradient-to-b from-primary/25 via-card/85 to-card/60 border-primary ring-4 ring-primary/40 shadow-[0_24px_50px_-10px_rgba(var(--primary-rgb,59,130,246),0.5),0_10px_20px_-4px_rgba(0,0,0,0.35),inset_0_2.5px_4px_rgba(255,255,255,0.9),inset_0_-4px_8px_rgba(0,0,0,0.25)] -translate-y-2.5 scale-105"
                          : "bg-gradient-to-b from-card/95 via-card/75 to-card/55 border-border/70 shadow-[0_16px_35px_-8px_rgba(0,0,0,0.35),0_6px_14px_-2px_rgba(0,0,0,0.2),inset_0_2px_3px_rgba(255,255,255,0.7),inset_0_-3px_6px_rgba(0,0,0,0.2)] hover:border-primary/60 hover:shadow-[0_24px_48px_-10px_rgba(0,0,0,0.5),inset_0_2.5px_4px_rgba(255,255,255,0.9)]"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="3xl"
                        className="drop-shadow-[0_12px_14px_rgba(0,0,0,0.3)] transition-transform duration-300 group-hover:scale-110 group-hover:drop-shadow-[0_16px_20px_rgba(0,0,0,0.4)]"
                      />
                      {isSelected && (
                        <div className="absolute -top-3 -right-3 w-8 h-8 sm:w-9 sm:h-9 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-xl shadow-primary/50 ring-4 ring-background animate-in zoom-in-50 duration-200">
                          <CheckCircle2 className="w-5 h-5 sm:w-6 sm:h-6" />
                        </div>
                      )}
                    </div>
                    <span
                      className={cn(
                        "text-base sm:text-lg font-bold tracking-tight transition-colors",
                        isSelected ? "text-foreground font-extrabold" : "text-muted-foreground group-hover:text-foreground"
                      )}
                    >
                      {p.label}
                    </span>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* Compact Option Cards: Direct Messaging & Post Comments (Centered, Same Height) */}
        <Reveal delay={50}>
          <div className="flex flex-col items-center space-y-2.5 max-w-lg mx-auto w-full pt-1">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Automated Surfaces (Select one or both)
            </span>
            <div className="flex items-center justify-center gap-3 w-full">
              {/* Direct Messaging Button */}
              <button
                type="button"
                onClick={handleToggleDms}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-xl border text-sm font-medium transition-all duration-200 cursor-pointer h-10 shadow-sm",
                  dmsActive
                    ? "bg-primary/15 border-primary text-foreground ring-1 ring-primary/40 font-semibold shadow-primary/10"
                    : "bg-background/50 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50"
                )}
              >
                <MessageSquare className="w-4 h-4 text-sky-400 shrink-0" />
                <span>Direct Messaging</span>
                {dmsActive && <CheckCircle2 className="w-3.5 h-3.5 text-primary ml-1 shrink-0" />}
              </button>

              {/* Post Comments Button */}
              <button
                type="button"
                disabled={!selectedPlatformMeta.supportsComments}
                onClick={handleToggleComments}
                className={cn(
                  "flex-1 flex items-center justify-center gap-2 py-2 px-4 rounded-xl border text-sm font-medium transition-all duration-200 h-10 shadow-sm",
                  !selectedPlatformMeta.supportsComments
                    ? "opacity-40 cursor-not-allowed bg-muted/20 border-border/30 text-muted-foreground"
                    : commentsActive
                    ? "bg-primary/15 border-primary text-foreground ring-1 ring-primary/40 font-semibold cursor-pointer shadow-primary/10"
                    : "bg-background/50 border-border/60 text-muted-foreground hover:text-foreground hover:bg-muted/50 cursor-pointer"
                )}
              >
                <MessageCircle className="w-4 h-4 text-emerald-400 shrink-0" />
                <span>Post Comments</span>
                {commentsActive && selectedPlatformMeta.supportsComments && <CheckCircle2 className="w-3.5 h-3.5 text-primary ml-1 shrink-0" />}
              </button>
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="violet" />

        {/* Configuration Sections */}
        <div className="space-y-8">
          {/* 1. Direct Messaging Agent Configuration */}
          {dmsActive && (
            <Reveal delay={70}>
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-sky-500/5 border border-sky-500/20">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-xl bg-sky-500/15 flex items-center justify-center text-sky-400">
                      <MessageSquare className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-foreground">Direct Messaging Agent Configuration</h3>
                        <Badge variant="outline" className="text-sky-400 border-sky-500/30 bg-sky-500/10 text-xs">
                          {selectedPlatformMeta.label} DMs
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Configure AI instructions, knowledge base (RAG), database connectors, and reply thresholds for direct messages.
                      </p>
                    </div>
                  </div>
                </div>

                <GradientRingCard
                  variant={selectedPlatformMeta.colorPreset}
                  padded={false}
                  hoverLift={false}
                  ringIntensity="subtle"
                  innerClassName="p-4 md:p-6"
                >
                  <AiAgentManager
                    key={`${platform}-dms`}
                    platform={platform}
                    activeTab={activeTab}
                    onTabChange={handleTabChange}
                  />
                </GradientRingCard>
              </div>
            </Reveal>
          )}

          {/* 2. Post Comments Configuration */}
          {commentsActive && selectedPlatformMeta.supportsComments && (
            <Reveal delay={90}>
              <div className="space-y-4">
                <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 rounded-2xl bg-emerald-500/5 border border-emerald-500/20">
                  <div className="flex items-center gap-3">
                    <div className="h-9 w-9 rounded-xl bg-emerald-500/15 flex items-center justify-center text-emerald-400">
                      <MessageCircle className="w-5 h-5" />
                    </div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-bold text-base text-foreground">Post Comments Configuration</h3>
                        <Badge variant="outline" className="text-emerald-400 border-emerald-500/30 bg-emerald-500/10 text-xs">
                          {selectedPlatformMeta.label} Comments
                        </Badge>
                      </div>
                      <p className="text-xs text-muted-foreground mt-0.5">
                        Configure automated comment responses, keyword triggers, and moderation rules for public posts on {selectedPlatformMeta.label}.
                      </p>
                    </div>
                  </div>
                </div>

                <GradientRingCard
                  variant="emerald"
                  padded={false}
                  hoverLift={false}
                  ringIntensity="subtle"
                  innerClassName="p-4 md:p-6 space-y-6"
                >
                  <AutomationHandlerCard
                    platform={platform}
                  />
                  <AutoReplyManager
                    platform={platform}
                    title={`${selectedPlatformMeta.label} Comments Auto-Replies & Triggers`}
                    description={`Set keyword triggers and AI instant replies for public post comments on ${selectedPlatformMeta.label}.`}
                  />
                </GradientRingCard>
              </div>
            </Reveal>
          )}
        </div>
      </div>
    </DashboardLayout>
  );
}
