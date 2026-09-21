import { useState, useEffect } from "react";
import { Link } from "react-router-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import {
  Loader2,
  CheckCircle2,
  XCircle,
  Clock,
  Send,
  ChevronRight,
  Upload,
  Cog,
  Video,
} from "lucide-react";
import type { PublishingPost } from "@/hooks/useRealtimePostUpdates";

// TikTok-specific status phases
type TikTokPhase = "uploading" | "processing" | "publishing" | "complete" | "failed";

interface PublishingStatusWidgetProps {
  publishingPosts: Map<string, PublishingPost>;
  isPublishing: boolean;
}

export function PublishingStatusWidget({
  publishingPosts,
  isPublishing,
}: PublishingStatusWidgetProps) {
  const [isOpen, setIsOpen] = useState(false);

  if (!isPublishing) return null;

  const posts = Array.from(publishingPosts.values());
  const totalPlatforms = posts.reduce((acc, p) => acc + p.platforms.length, 0);
  const completedPlatforms = posts.reduce(
    (acc, p) => acc + p.completedPlatforms.size,
    0
  );
  const progress = totalPlatforms > 0 ? (completedPlatforms / totalPlatforms) * 100 : 0;

  return (
    <Popover open={isOpen} onOpenChange={setIsOpen}>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="relative h-9 gap-2 text-sm font-medium"
        >
          <motion.div
            animate={{ rotate: 360 }}
            transition={{ duration: 1.5, repeat: Infinity, ease: "linear" }}
          >
            <Send className="h-4 w-4 text-primary" />
          </motion.div>
          <span className="hidden sm:inline">Publishing</span>
          <Badge
            variant="secondary"
            className="h-5 min-w-5 px-1.5 text-xs bg-primary/10 text-primary"
          >
            {posts.length}
          </Badge>
          {/* Pulse indicator */}
          <motion.div
            className="absolute top-1 end-1 h-2 w-2 rounded-full bg-primary"
            animate={{ scale: [1, 1.3, 1], opacity: [1, 0.5, 1] }}
            transition={{ duration: 1.5, repeat: Infinity }}
          />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-80 p-0 bg-background border-border"
      >
        <div className="p-3 border-b border-border">
          <div className="flex items-center justify-between mb-2">
            <h4 className="font-semibold text-sm">Publishing Progress</h4>
            <span className="text-xs text-muted-foreground">
              {completedPlatforms}/{totalPlatforms} platforms
            </span>
          </div>
          <Progress value={progress} className="h-1.5" />
        </div>

        <div className="max-h-64 overflow-y-auto">
          {posts.map((post) => (
            <PublishingPostItem key={post.postId} post={post} />
          ))}
        </div>

        <div className="p-2 border-t border-border">
          <Link to="/history" onClick={() => setIsOpen(false)}>
            <Button variant="ghost" size="sm" className="w-full justify-between">
              View History
              <ChevronRight className="h-4 w-4" />
            </Button>
          </Link>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function PublishingPostItem({ post }: { post: PublishingPost }) {
  const [tiktokPhases, setTiktokPhases] = useState<Map<string, TikTokPhase>>(new Map());
  
  // Calculate if all platforms are done
  const allDone = post.platforms.every(p => post.completedPlatforms.has(p));

  useEffect(() => {
    const hasTikTok = post.platforms.includes("tiktok");
    if (!hasTikTok) return;
    
    // Don't run interval if all platforms are done
    if (allDone) return;

    const interval = setInterval(() => {
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
    }, 1000);
    
    return () => clearInterval(interval);
  }, [post.startedAt, post.platforms, post.completedPlatforms, tiktokPhases, allDone]);

  return (
    <div key={post.postId} className="p-3 border-b border-border last:border-0">
      <div className="flex items-center gap-2 mb-2">
        {allDone ? (
          <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" />
        ) : (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        )}
        <span className="text-xs text-muted-foreground">
          {allDone ? "Completed" : `Started ${formatElapsed(post.startedAt)}`}
        </span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {post.platforms.map((platform) => {
          const status = post.completedPlatforms.get(platform);
          const tiktokPhase = platform === "tiktok" ? tiktokPhases.get("tiktok") : undefined;
          
          return (
            <PlatformBadge
              key={platform}
              platform={platform}
              status={status}
              tiktokPhase={tiktokPhase}
            />
          );
        })}
      </div>
    </div>
  );
}

function PlatformBadge({
  platform, 
  status,
  tiktokPhase 
}: { 
  platform: string; 
  status?: string;
  tiktokPhase?: TikTokPhase;
}) {
  const getTikTokDisplay = () => {
    if (status === "success" || tiktokPhase === "complete") {
      return { icon: <CheckCircle2 className="h-3 w-3" />, label: "Published", className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    }
    if (status === "failed" || tiktokPhase === "failed") {
      return { icon: <XCircle className="h-3 w-3" />, label: "Failed", className: "bg-destructive/10 text-destructive" };
    }
    if (status === "pending_inbox") {
      return { icon: <Clock className="h-3 w-3" />, label: "Check Inbox", className: "bg-blue-500/10 text-blue-600" };
    }
    
    switch (tiktokPhase) {
      case "uploading":
        return { icon: <Upload className="h-3 w-3 animate-pulse" />, label: "Uploading", className: "bg-amber-500/10 text-amber-600" };
      case "processing":
        return { icon: <Cog className="h-3 w-3 animate-spin" />, label: "Processing", className: "bg-blue-500/10 text-blue-600" };
      case "publishing":
        return { icon: <Video className="h-3 w-3 animate-pulse" />, label: "Publishing", className: "bg-primary/10 text-primary" };
      default:
        return { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: null, className: "bg-secondary" };
    }
  };

  const getStatusDisplay = () => {
    if (platform === "tiktok") {
      return getTikTokDisplay();
    }

    if (status === "success") {
      return { icon: <CheckCircle2 className="h-3 w-3" />, label: null, className: "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400" };
    }
    if (status === "failed") {
      return { icon: <XCircle className="h-3 w-3" />, label: null, className: "bg-destructive/10 text-destructive" };
    }
    if (status === "pending_inbox") {
      return { icon: <Clock className="h-3 w-3" />, label: null, className: "bg-blue-500/10 text-blue-600" };
    }
    return { icon: <Loader2 className="h-3 w-3 animate-spin" />, label: null, className: "bg-secondary" };
  };

  const display = getStatusDisplay();

  return (
    <Badge
      variant="secondary"
      className={`flex items-center gap-1.5 text-xs py-0.5 ${display.className}`}
    >
      <PlatformIcon platform={platform as any} size="xs" />
      <span className="hidden sm:inline">
        {display.label || getPlatformName(platform as any)}
      </span>
      {display.icon}
    </Badge>
  );
}

function formatElapsed(startedAt: number): string {
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m ago`;
}
