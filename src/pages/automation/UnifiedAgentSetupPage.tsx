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
      <div className="w-full space-y-8 pb-12">
        {/* Header */}
        <Reveal>
          <div className="flex flex-col items-center text-center space-y-2 max-w-3xl mx-auto">
            <div className="flex items-center justify-center gap-2.5">
              <Icon3D icon={Bot} variant="violet" size="md" />
              <GradientHeading preset="violet-sky" size="xl" as="h1">
                Agent Setup Portal
              </GradientHeading>
              <Badge variant="outline" className="border-violet-500/30 text-violet-400 bg-violet-500/10 gap-1 text-xs">
                <Sparkles className="w-3 h-3" /> Unified AI Studio
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Configure intelligent AI assistants, knowledge bases, database connectors, and automations across all social channels.
            </p>
          </div>
        </Reveal>

        {/* Small Centered 3D Platform Cards */}
        <Reveal delay={30}>
          <div className="flex flex-col items-center space-y-3">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Select Platform
            </span>
            <div className="flex items-center justify-center gap-3 sm:gap-4 flex-wrap max-w-3xl" role="tablist" aria-label="Social Channels">
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
                      "group relative flex flex-col items-center justify-center p-3 sm:p-3.5 rounded-2xl border transition-all duration-200 min-w-[110px] sm:min-w-[130px] text-center cursor-pointer",
                      isSelected
                        ? "bg-card/90 border-primary shadow-lg shadow-primary/10 ring-2 ring-primary/40 -translate-y-1 scale-105"
                        : "bg-card/40 hover:bg-card/70 border-border/60 hover:border-border hover:-translate-y-0.5"
                    )}
                  >
                    <div className="mb-1.5 transition-transform duration-200 group-hover:scale-110">
                      <Icon3D
                        icon={() => <PlatformIcon platform={p.id} className="w-5 h-5" />}
                        variant={p.colorPreset}
                        size="sm"
                      />
                    </div>
                    <span className={cn("text-xs sm:text-sm font-semibold transition-colors", isSelected ? "text-foreground" : "text-muted-foreground group-hover:text-foreground")}>
                      {p.label}
                    </span>
                    {isSelected && (
                      <CheckCircle2 className="w-3.5 h-3.5 text-primary absolute top-2 right-2" />
                    )}
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* Option Cards: Direct Messaging & Post Comments (Select Both Supported) */}
        <Reveal delay={50}>
          <div className="flex flex-col items-center space-y-3 max-w-2xl mx-auto w-full">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Automated Surfaces (Select one or both)
            </span>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full">
              {/* Direct Messaging Card */}
              <button
                type="button"
                onClick={handleToggleDms}
                className={cn(
                  "relative flex items-center justify-between p-4 rounded-2xl border transition-all duration-200 text-left group cursor-pointer",
                  dmsActive
                    ? "bg-sky-500/10 border-sky-500/50 ring-1 ring-sky-500/30 shadow-md shadow-sky-500/5"
                    : "bg-card/40 border-border/60 hover:bg-card/70 hover:border-border"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-10 w-10 rounded-xl flex items-center justify-center transition-colors shrink-0",
                    dmsActive ? "bg-sky-500/20 text-sky-400" : "bg-muted text-muted-foreground"
                  )}>
                    <MessageSquare className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm text-foreground">Direct Messaging</h4>
                      {dmsActive && <Badge variant="outline" className="text-[10px] text-sky-400 border-sky-500/30 py-0 h-4">Enabled</Badge>}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Inbound direct chats & DM automations
                    </p>
                  </div>
                </div>
                <Checkbox
                  checked={dmsActive}
                  onCheckedChange={handleToggleDms}
                  className="data-[state=checked]:bg-sky-500 data-[state=checked]:border-sky-500"
                />
              </button>

              {/* Post Comments Card */}
              <button
                type="button"
                disabled={!selectedPlatformMeta.supportsComments}
                onClick={handleToggleComments}
                className={cn(
                  "relative flex items-center justify-between p-4 rounded-2xl border transition-all duration-200 text-left group",
                  !selectedPlatformMeta.supportsComments
                    ? "opacity-50 cursor-not-allowed bg-muted/20 border-border/30"
                    : commentsActive
                    ? "bg-emerald-500/10 border-emerald-500/50 ring-1 ring-emerald-500/30 shadow-md shadow-emerald-500/5 cursor-pointer"
                    : "bg-card/40 border-border/60 hover:bg-card/70 hover:border-border cursor-pointer"
                )}
              >
                <div className="flex items-center gap-3">
                  <div className={cn(
                    "h-10 w-10 rounded-xl flex items-center justify-center transition-colors shrink-0",
                    !selectedPlatformMeta.supportsComments
                      ? "bg-muted/40 text-muted-foreground"
                      : commentsActive
                      ? "bg-emerald-500/20 text-emerald-400"
                      : "bg-muted text-muted-foreground"
                  )}>
                    <MessageCircle className="w-5 h-5" />
                  </div>
                  <div>
                    <div className="flex items-center gap-2">
                      <h4 className="font-semibold text-sm text-foreground">Post Comments</h4>
                      {!selectedPlatformMeta.supportsComments ? (
                        <Badge variant="outline" className="text-[10px] text-muted-foreground py-0 h-4">N/A on WhatsApp</Badge>
                      ) : commentsActive ? (
                        <Badge variant="outline" className="text-[10px] text-emerald-400 border-emerald-500/30 py-0 h-4">Enabled</Badge>
                      ) : null}
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Public post replies & comment moderation
                    </p>
                  </div>
                </div>
                <Checkbox
                  checked={commentsActive}
                  disabled={!selectedPlatformMeta.supportsComments}
                  onCheckedChange={handleToggleComments}
                  className="data-[state=checked]:bg-emerald-500 data-[state=checked]:border-emerald-500"
                />
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
