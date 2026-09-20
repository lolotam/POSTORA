import { useEffect, useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { Loader2, CheckCircle2, XCircle, Clock, Upload, Cog, Video } from "lucide-react";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";
import type { PublishingPost } from "@/hooks/useRealtimePostUpdates";
import { useTranslation } from "react-i18next";

// TikTok-specific status phases
type TikTokPhase = "uploading" | "processing" | "publishing" | "complete" | "failed";

interface PublishingStatusIndicatorProps {
  publishingPosts: Map<string, PublishingPost>;
}

export function PublishingStatusIndicator({ publishingPosts }: PublishingStatusIndicatorProps) {
  const { t } = useTranslation("history");
  const [isExpanded, setIsExpanded] = useState(true);

  // Auto-expand when new posts start publishing
  useEffect(() => {
    if (publishingPosts.size > 0) {
      setIsExpanded(true);
    }
  }, [publishingPosts.size]);

  if (publishingPosts.size === 0) return null;

  const posts = Array.from(publishingPosts.values());

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0, y: -20 }}
        animate={{ opacity: 1, y: 0 }}
        exit={{ opacity: 0, y: -20 }}
        className="mb-6"
      >
        <div className="rounded-xl border border-primary/30 bg-primary/5 backdrop-blur-sm overflow-hidden">
          {/* Header */}
          <button
            onClick={() => setIsExpanded(!isExpanded)}
            className="w-full flex items-center justify-between px-4 py-3 hover:bg-primary/5 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="relative">
                <Loader2 className="w-5 h-5 text-primary animate-spin" />
                <span className="absolute -top-1 -right-1 w-2 h-2 bg-primary rounded-full animate-pulse" />
              </div>
              <span className="font-medium text-foreground">
                {t("indicator.publishingPosts", "Publishing {{count}} post(s)...", { count: posts.length })}
              </span>
            </div>
            <span className="text-xs text-muted-foreground">
              {isExpanded ? t("indicator.clickToCollapse", "Click to collapse") : t("indicator.clickToExpand", "Click to expand")}
            </span>
          </button>

          {/* Expanded content */}
          <AnimatePresence>
            {isExpanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.2 }}
                className="border-t border-primary/20"
              >
                <div className="p-4 space-y-4">
                  {posts.map((post) => (
                    <PublishingPostItem key={post.postId} post={post} />
                  ))}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </AnimatePresence>
  );
}

function PublishingPostItem({ post }: { post: PublishingPost }) {
  const [elapsedTime, setElapsedTime] = useState(0);
  const [tiktokPhases, setTiktokPhases] = useState<Map<string, TikTokPhase>>(new Map());
  
  // Calculate if all platforms are done
  const allDone = post.platforms.every(p => post.completedPlatforms.has(p));

  useEffect(() => {
    // Don't run interval if all platforms are done
    if (allDone) return;
    
    const interval = setInterval(() => {
      setElapsedTime(Math.floor((Date.now() - post.startedAt) / 1000));
      
      // Simulate TikTok processing phases based on elapsed time for pending TikTok posts
      const hasTikTok = post.platforms.includes("tiktok");
      if (hasTikTok) {
        const tiktokStatus = post.completedPlatforms.get("tiktok");
        if (!tiktokStatus) {
          const elapsed = Math.floor((Date.now() - post.startedAt) / 1000);
          const newPhases = new Map(tiktokPhases);
          
          if (elapsed < 3) {
            newPhases.set("tiktok", "uploading");
          } else if (elapsed < 8) {
            newPhases.set("tiktok", "processing");
          } else {
            newPhases.set("tiktok", "publishing");
          }
          setTiktokPhases(newPhases);
        } else if (tiktokStatus === "success") {
          const newPhases = new Map(tiktokPhases);
          newPhases.set("tiktok", "complete");
          setTiktokPhases(newPhases);
        } else if (tiktokStatus === "failed") {
          const newPhases = new Map(tiktokPhases);
          newPhases.set("tiktok", "failed");
          setTiktokPhases(newPhases);
        }
      }
    }, 1000);
    return () => clearInterval(interval);
  }, [post.startedAt, post.platforms, post.completedPlatforms, tiktokPhases, allDone]);

  const formatTime = (seconds: number) => {
    if (seconds < 60) return `${seconds}s`;
    return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  };

  const { t } = useTranslation("history");
  const completedCount = post.completedPlatforms.size;
  const totalCount = post.platforms.length;
  const progress = (completedCount / totalCount) * 100;

  return (
    <div className="space-y-3">
      {/* Progress header */}
      <div className="flex items-center justify-between text-sm">
        <span className="text-muted-foreground">
          {t("indicator.platformsProgress", "{{completed}} of {{total}} platforms", { completed: completedCount, total: totalCount })}
        </span>
        <div className="flex items-center gap-2 text-muted-foreground">
          <Clock className="w-3.5 h-3.5" />
          <span>{formatTime(elapsedTime)}</span>
        </div>
      </div>

      {/* Progress bar */}
      <div className="h-1.5 bg-muted rounded-full overflow-hidden">
        <motion.div
          className="h-full bg-gradient-to-r from-primary to-primary/70"
          initial={{ width: 0 }}
          animate={{ width: `${progress}%` }}
          transition={{ duration: 0.3 }}
        />
      </div>

      {/* Platform statuses */}
      <div className="flex flex-wrap gap-2">
        {post.platforms.map((platform) => {
          const status = post.completedPlatforms.get(platform);
          const tiktokPhase = platform === "tiktok" ? tiktokPhases.get("tiktok") : undefined;
          
          return (
            <PlatformStatusBadge
              key={platform}
              platform={platform as Platform}
              status={status}
              tiktokPhase={tiktokPhase}
            />
          );
        })}
      </div>
    </div>
  );
}

function PlatformStatusBadge({
  platform,
  status,
  tiktokPhase,
}: {
  platform: Platform;
  status?: "success" | "failed" | "pending_inbox";
  tiktokPhase?: TikTokPhase;
}) {
  const { t } = useTranslation("history");

  // Get TikTok-specific status display
  const getTikTokStatusDisplay = () => {
    if (status === "success" || tiktokPhase === "complete") {
      return { icon: <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />, label: t("status.published", "Published") };
    }
    if (status === "failed" || tiktokPhase === "failed") {
      return { icon: <XCircle className="w-3.5 h-3.5 text-destructive" />, label: t("common:status.failed", "Failed") };
    }
    if (status === "pending_inbox") {
      return { icon: <Clock className="w-3.5 h-3.5 text-blue-500" />, label: t("status.pendingInbox", "Check Inbox") };
    }
    
    switch (tiktokPhase) {
      case "uploading":
        return { 
          icon: <Upload className="w-3.5 h-3.5 animate-pulse text-amber-500" />, 
          label: t("indicator.uploading", "Uploading...") 
        };
      case "processing":
        return { 
          icon: <Cog className="w-3.5 h-3.5 animate-spin text-blue-500" />, 
          label: t("common:status.processing", "Processing...") 
        };
      case "publishing":
        return { 
          icon: <Video className="w-3.5 h-3.5 animate-pulse text-primary" />, 
          label: t("indicator.publishing", "Publishing...") 
        };
      default:
        return { 
          icon: <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />, 
          label: null 
        };
    }
  };

  const getStatusIcon = () => {
    // Special handling for TikTok
    if (platform === "tiktok") {
      return getTikTokStatusDisplay().icon;
    }

    switch (status) {
      case "success":
        return <CheckCircle2 className="w-3.5 h-3.5 text-emerald-500" />;
      case "failed":
        return <XCircle className="w-3.5 h-3.5 text-destructive" />;
      case "pending_inbox":
        return <Clock className="w-3.5 h-3.5 text-blue-500" />;
      default:
        return <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground" />;
    }
  };

  const getTikTokLabel = () => {
    if (platform !== "tiktok") return null;
    const display = getTikTokStatusDisplay();
    return display.label;
  };

  const getBackgroundClass = () => {
    if (status === "success" || tiktokPhase === "complete") {
      return "bg-emerald-500/10 text-emerald-600 border border-emerald-500/20";
    }
    if (status === "failed" || tiktokPhase === "failed") {
      return "bg-destructive/10 text-destructive border border-destructive/20";
    }
    if (status === "pending_inbox") {
      return "bg-blue-500/10 text-blue-600 border border-blue-500/20";
    }
    if (platform === "tiktok" && tiktokPhase) {
      switch (tiktokPhase) {
        case "uploading":
          return "bg-amber-500/10 text-amber-600 border border-amber-500/20";
        case "processing":
          return "bg-blue-500/10 text-blue-600 border border-blue-500/20";
        case "publishing":
          return "bg-primary/10 text-primary border border-primary/20";
      }
    }
    return "bg-muted text-muted-foreground border border-border";
  };

  const tiktokLabel = getTikTokLabel();

  return (
    <motion.div
      initial={{ scale: 0.9, opacity: 0 }}
      animate={{ scale: 1, opacity: 1 }}
      className={cn(
        "flex items-center gap-2 px-3 py-1.5 rounded-full text-xs font-medium",
        getBackgroundClass()
      )}
    >
      <PlatformIcon platform={platform} size="xs" />
      <span>{tiktokLabel || getPlatformName(platform)}</span>
      {getStatusIcon()}
    </motion.div>
  );
}
