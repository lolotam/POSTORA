import { useTranslation } from "react-i18next";
import "@/i18n";
import { Navigate, useNavigate, useSearchParams } from "react-router-dom";
import { motion } from "framer-motion";
import { DashboardLayout } from "@/components/layout/DashboardLayout";
import { CommentManagerPanel } from "@/components/comments/CommentManagerPanel";
import { AutomationHandlerCard } from "@/components/messaging/AutomationHandlerCard";
import { useSocialAccounts } from "@/hooks/useSocialAccounts";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { GradientDivider, Reveal, GradientRingCard } from "@/components/fx";
import { CheckCircle2, ExternalLink } from "lucide-react";
import { PlatformIcon } from "@/components/PlatformIcon";
import { cn } from "@/lib/utils";

export type CommentPlatform = "facebook" | "instagram" | "threads" | "youtube";

interface PlatformOption {
  id: CommentPlatform;
  colorPreset: "sky" | "rose" | "violet";
  /** When true, clicking this platform navigates away instead of loading inline content */
  externalPath?: string;
}

const PLATFORMS: PlatformOption[] = [
  { id: "facebook", colorPreset: "sky" },
  { id: "instagram", colorPreset: "rose" },
  // Threads has its own dedicated page at /messaging/thread — redirect there
  { id: "threads", colorPreset: "violet", externalPath: "/messaging/thread" },
  // GradientRingCard has no red preset; rose is the nearest, and adding one is not this tile's job.
  { id: "youtube", colorPreset: "rose" },
];

export default function CommentManagerPage() {
  const { t } = useTranslation("automation");
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { flags, isLoading: flagsLoading } = useFeatureFlags();
  useSocialAccounts();

  // The YouTube tile is flag-gated, and the flag stays off for admins too until the migration
  // that admits youtube rows has been applied by hand (see VISIBILITY_FLAG_KEYS).
  const platforms = PLATFORMS.filter((p) => p.id !== "youtube" || flags.youtubeComments);

  const platformParam = searchParams.get("platform") as CommentPlatform;
  const platform: CommentPlatform = platforms.some((p) => p.id === platformParam) ? platformParam : "facebook";

  const selectedPlatformMeta = platforms.find((p) => p.id === platform) || platforms[0];

  const handlePlatformChange = (p: PlatformOption) => {
    if (p.externalPath) {
      navigate(p.externalPath);
      return;
    }
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.set("platform", p.id);
      return next;
    }, { replace: true });
  };

  if (!flagsLoading && !flags.commentManager) {
    return <Navigate to="/dashboard" replace />;
  }

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
                <h1 className="text-2xl sm:text-3xl md:text-4xl lg:text-5xl font-black uppercase tracking-[0.35em] sm:tracking-[0.48em] md:tracking-[0.6em] bg-gradient-to-r from-emerald-500 via-teal-500 to-cyan-500 dark:from-emerald-400 dark:via-teal-400 dark:to-cyan-400 bg-clip-text text-transparent drop-shadow-sm text-center">
                  {t("header.commentsManager", "Comments Manager")}
                </h1>
              </motion.div>
            </div>

            <div
              className="flex items-center justify-center gap-6 sm:gap-8 md:gap-10 lg:gap-12 px-4 py-3 sm:py-4 flex-wrap bg-transparent"
              role="tablist"
              aria-label={t("comments.channelsAria", "Comment Channels")}
            >
              {platforms.map((p) => {
                const isSelected = platform === p.id;
                return (
                  <button
                    key={p.id}
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    onClick={() => handlePlatformChange(p)}
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
                      {/* External link indicator for Threads */}
                      {p.externalPath && (
                        <div className="absolute -top-2 -end-2 w-5 h-5 rounded-full bg-muted border border-border/60 flex items-center justify-center shadow-sm">
                          <ExternalLink className="w-2.5 h-2.5 text-muted-foreground" />
                        </div>
                      )}
                      {isSelected && !p.externalPath && (
                        <div className="absolute -top-2 -end-2 w-6 h-6 sm:w-7 sm:h-7 rounded-full bg-primary text-primary-foreground flex items-center justify-center shadow-lg shadow-primary/50 ring-2 ring-background animate-in zoom-in-50 duration-200">
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
                        {p.id === "facebook"
                          ? t("platform.facebook", "Facebook")
                          : p.id === "instagram"
                          ? t("platform.instagram", "Instagram")
                          : p.id === "threads"
                          ? t("platform.threads", "Threads")
                          : t("platform.youtube", "YouTube")}
                      </span>
                    </div>
                  </button>
                );
              })}
            </div>
          </div>
        </Reveal>

        <GradientDivider tone="emerald" />

        {/* Platform Comment Feed Panel */}
        <Reveal delay={60}>
          <GradientRingCard
            variant={selectedPlatformMeta.colorPreset}
            padded={false}
            hoverLift={false}
            ringIntensity="subtle"
            innerClassName="p-4 md:p-6"
          >
            {platform === "facebook" && (
              <>
                <AutomationHandlerCard platform="facebook" surface="comments" />
                <CommentManagerPanel platform="facebook" />
              </>
            )}
            {platform === "instagram" && (
              <>
                <AutomationHandlerCard platform="instagram" surface="comments" />
                <CommentManagerPanel platform="instagram" />
              </>
            )}
            {platform === "youtube" && (
              <>
                <AutomationHandlerCard platform="youtube" surface="comments" />
                <CommentManagerPanel platform="youtube" />
              </>
            )}
          </GradientRingCard>
        </Reveal>
      </div>
    </DashboardLayout>
  );
}
