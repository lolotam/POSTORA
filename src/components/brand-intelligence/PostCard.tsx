import { useTranslation } from "react-i18next";
import { AspectRatio } from "@/components/ui/aspect-ratio";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Eye, Sparkles, Trash2, Loader2 } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import type { BrandPost } from "@/types/brand-intelligence";

interface PostCardProps {
  post: BrandPost;
  index: number;
  onClick: (post: BrandPost) => void;
  hasContent?: boolean;
  /** When true, render an inline Trash button in the hover overlay. */
  canDelete?: boolean;
  /** When true, swap the trash icon for a spinner. */
  isDeleting?: boolean;
  /** Called when the user clicks the inline delete button. Parent owns the confirmation dialog. */
  onDelete?: (post: BrandPost) => void;
}

const MEDIA_BADGES: Record<string, { label: string; className: string }> = {
  REEL: { label: "REEL", className: "bg-muted text-foreground border-border" },
  IMAGE: { label: "IMAGE", className: "bg-blue-500/20 text-blue-400 border-blue-500/30" },
  CAROUSEL: { label: "CAROUSEL", className: "bg-orange-500/20 text-orange-400 border-orange-500/30" },
  VIDEO: { label: "VIDEO", className: "bg-muted text-foreground border-border" },
};

export function PostCard({ post, index, onClick, hasContent, canDelete, isDeleting, onDelete }: PostCardProps) {
  const { t } = useTranslation("analytics");
  const badge = MEDIA_BADGES[post.mediaType] || MEDIA_BADGES.IMAGE;
  const isHot = post.engagementScore > 10000;

  return (
    <div
      className="group cursor-pointer rounded-lg overflow-hidden border border-border/50 bg-card animate-[fadeSlideUp_0.4s_ease-out_both]"
      style={{ animationDelay: `${index * 50}ms` }}
      onClick={() => onClick(post)}
    >
      <AspectRatio ratio={1}>
        <div className="relative w-full h-full">
          {post.thumbnailUrl ? (
            <img
              src={post.thumbnailUrl}
              alt=""
              className="w-full h-full object-cover"
              loading="lazy"
              referrerPolicy="no-referrer"
              onError={(e) => {
                const img = e.target as HTMLImageElement;
                img.style.display = "none";
                const parent = img.parentElement;
                if (parent && !parent.querySelector('.placeholder-icon')) {
                  const placeholder = document.createElement("div");
                  placeholder.className = "placeholder-icon w-full h-full flex items-center justify-center text-white/80 bg-muted";
                  placeholder.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32" viewBox="0 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
                  parent.appendChild(placeholder);
                }
              }}
            />
          ) : (
            <div className="w-full h-full bg-muted" />
          )}

          {/* Top badges */}
          <div className="absolute top-1.5 start-1.5 flex gap-1">
            <Badge variant="outline" className={`text-[10px] px-1.5 py-0 border ${badge.className}`}>
              {post.mediaType === "REEL" ? t("posts.reel", "REEL")
                : post.mediaType === "IMAGE" ? t("posts.image", "IMAGE")
                : post.mediaType === "CAROUSEL" ? t("posts.carousel", "CAROUSEL")
                : post.mediaType === "VIDEO" ? t("posts.video", "VIDEO")
                : t("posts.image", "IMAGE")}
            </Badge>
            {hasContent && (
              <Badge className="text-[10px] px-1.5 py-0 text-white border-0 bg-neutral-900 dark:bg-neutral-800">
                {t("posts.aiReady", "AI ✓")}
              </Badge>
            )}
          </div>
          <div className="absolute top-1.5 end-1.5">
            <Badge variant="secondary" className={`text-[10px] px-1.5 py-0 ${isHot ? "text-orange-400" : ""}`}>
              {isHot && "🔥 "}{post.engagementScore.toLocaleString()}
            </Badge>
          </div>

          {/* Hover overlay */}
          <div className="absolute inset-0 bg-black/70 opacity-0 group-hover:opacity-100 transition-opacity duration-200 flex flex-col items-center justify-center gap-2 p-3">
            <div className="flex items-center gap-3 text-white text-xs">
              <span>❤️ {post.likesCount.toLocaleString()}</span>
              <span>💬 {post.commentsCount.toLocaleString()}</span>
              {post.videoViewCount ? <span>▶️ {post.videoViewCount.toLocaleString()}</span> : null}
            </div>
            <div className="flex gap-2 mt-1">
              <Button size="sm" variant="secondary" className="h-7 text-xs gap-1" onClick={(e) => { e.stopPropagation(); onClick(post); }}>
                <Eye className="w-3 h-3" /> {t("posts.details", "Details")}
              </Button>
              <Button size="sm" className="h-7 text-xs gap-1 border-0 text-white bg-neutral-900 dark:bg-neutral-800" onClick={(e) => { e.stopPropagation(); onClick(post); }}>
                <Sparkles className="w-3 h-3" /> {t("actions.generate", "Generate")}
              </Button>
              {canDelete && (
                <Button
                  size="sm"
                  variant="secondary"
                  className="h-7 text-xs gap-1 bg-destructive/90 hover:bg-destructive text-destructive-foreground"
                  onClick={(e) => { e.stopPropagation(); onDelete?.(post); }}
                  disabled={isDeleting}
                  aria-label={t("posts.deleteAria", "Delete from Threads")}
                >
                  {isDeleting ? <Loader2 className="w-3 h-3 animate-spin" /> : <Trash2 className="w-3 h-3" />}
                </Button>
              )}
            </div>
          </div>
        </div>
      </AspectRatio>

      {/* Caption preview */}
      <div className="px-2 py-1.5">
        {post.caption && (
          <p className="text-xs text-muted-foreground line-clamp-2">{post.caption}</p>
        )}
        {post.timestamp && (
          <p className="text-[10px] text-muted-foreground/60 mt-0.5">
            {formatDistanceToNow(new Date(post.timestamp), { addSuffix: true })}
          </p>
        )}
      </div>
    </div>
  );
}
