import { Navigate, useSearchParams, Link } from "react-router-dom";
import { motion } from "framer-motion";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { AutoReplyManager } from "@/components/messaging/AutoReplyManager";
import { type AiAgentPlatform } from "@/hooks/useAiAgentConfig";
import { GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { Zap, Headphones, CheckCircle2 } from "lucide-react";
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
      <div className="w-full space-y-6 pb-12">
        {/* Animated Gliding Title & 3D Social Media Channels */}
        <Reveal>
          <div className="flex flex-col items-center justify-center space-y-4 pt-1 pb-2">
            {/* Animated Title Track moving across the width of the social media section */}
            <div className="w-full max-w-3xl mx-auto overflow-hidden relative py-3 select-none">
              <motion.div
                className="flex items-center justify-center whitespace-nowrap"
                initial={{ x: "-15%" }}
                animate={{ x: ["-15%", "15%", "-15%"] }}
                transition={{
                  duration: 6,
                  repeat: Infinity,
                  ease: "easeInOut",
                }}
              >
                <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-[0.35em] sm:tracking-[0.48em] md:tracking-[0.6em] bg-gradient-to-r from-sky-500 via-indigo-500 to-purple-500 dark:from-sky-400 dark:via-indigo-400 dark:to-purple-400 bg-clip-text text-transparent drop-shadow-sm text-center">
                  Messaging Automation
                </h1>
              </motion.div>
            </div>

            <div
              className="flex items-center justify-center gap-6 sm:gap-8 md:gap-10 lg:gap-12 px-4 py-3 sm:py-4 flex-wrap bg-transparent"
              role="tablist"
              aria-label="Social Channels"
            >
              {PLATFORMS.map((p) => {
                const isSelected = platform === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => handlePlatformChange(p.id)}
                    className="flex flex-col items-center gap-2 flex-shrink-0 transition-all duration-300 cursor-pointer group focus:outline-none"
                  >
                    <div
                      className={cn(
                        "relative w-20 h-20 sm:w-24 sm:h-24 md:w-28 md:h-28 rounded-2xl sm:rounded-3xl flex items-center justify-center border transition-all duration-300 overflow-visible",
                        // 3D glass specular highlight
                        "before:absolute before:inset-x-0 before:top-0 before:h-1/2 before:rounded-t-2xl sm:before:rounded-t-3xl before:bg-gradient-to-b before:from-white/40 before:via-white/15 before:to-transparent before:pointer-events-none",
                        isSelected
                          ? "bg-gradient-to-b from-primary/25 via-card/85 to-card/60 border-primary ring-4 ring-primary/40 shadow-[0_20px_40px_-8px_rgba(var(--primary-rgb,59,130,246),0.5),0_8px_16px_-4px_rgba(0,0,0,0.35),inset_0_2px_3px_rgba(255,255,255,0.9),inset_0_-3px_6px_rgba(0,0,0,0.25)] -translate-y-1.5 scale-105"
                          : "bg-card/40 backdrop-blur-md border-border/70 shadow-[0_12px_28px_-6px_rgba(0,0,0,0.35),0_4px_10px_-2px_rgba(0,0,0,0.2),inset_0_1.5px_2px_rgba(255,255,255,0.7),inset_0_-2px_4px_rgba(0,0,0,0.2)] hover:border-primary/60 hover:shadow-[0_18px_36px_-8px_rgba(0,0,0,0.5),inset_0_2px_3px_rgba(255,255,255,0.9)] hover:-translate-y-1.5 hover:scale-105"
                      )}
                    >
                      <PlatformIcon
                        platform={p.id}
                        size="2xl"
                        className="drop-shadow-[0_8px_10px_rgba(0,0,0,0.3)] transition-transform duration-300 group-hover:scale-110"
                      />
                      {isSelected && (
                        <div className="absolute -top-2 -right-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/50 ring-2 ring-background animate-in zoom-in-50 duration-200">
                          <CheckCircle2 className="w-4 h-4 sm:w-4.5 sm:h-4.5" />
                        </div>
                      )}
                    </div>

                    <div className="text-center">
                      <span
                        className={cn(
                          "block text-xs sm:text-sm font-bold tracking-tight transition-colors",
                          isSelected
                            ? "text-foreground font-extrabold"
                            : "text-muted-foreground group-hover:text-foreground"
                        )}
                      >
                        {p.label}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="sky" />

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
