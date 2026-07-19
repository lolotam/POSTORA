import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Platform } from "@/lib/types";
import { formatDistanceToNow } from "date-fns";
import { cn } from "@/lib/utils";
import { openExternalPostUrl } from "@/lib/openExternalPostUrl";
import { statusConfig, buildPostUrl } from "./historyUtils";
import {
  Clock,
  CheckCircle2,
  Image,
  MoreHorizontal,
  Loader2,
  Zap,
  MousePointer,
  RefreshCw,
  Eye,
  Trash2,
  Upload,
  ExternalLink,
  Inbox,
} from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  DropdownMenuSeparator,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface PlatformResult {
  id: string;
  platform: string;
  status: string | null;
  platform_post_id?: string | null;
  platform_post_url?: string | null;
  error_message?: string | null;
  social_account_id?: string | null;
  response_data?: Record<string, any> | null;
}

interface PostData {
  id: string;
  caption: string | null;
  platforms: string[];
  status: string | null;
  created_at: string;
  source?: string;
  media_file_ids?: string[] | null;
  metadata?: Record<string, any> | null;
  platformResults: PlatformResult[];
}

interface AccountInfo {
  username: string | null;
  avatarUrl: string | null;
  tiktokUsername?: string | null;
}

interface PostCardProps {
  post: PostData;
  isSelected: boolean;
  isRetrying: boolean;
  accountsCache: Record<string, AccountInfo>;
  onToggleSelection: (postId: string) => void;
  onViewDetails: (post: PostData) => void;
  onRetryFailed: (post: PostData) => void;
  onRetryWithMedia: (post: PostData) => void;
  onDelete: (post: PostData) => void;
  hasTikTokMediaError: boolean;
}

export function PostCard({
  post,
  isSelected,
  isRetrying,
  accountsCache,
  onToggleSelection,
  onViewDetails,
  onRetryFailed,
  onRetryWithMedia,
  onDelete,
  hasTikTokMediaError,
}: PostCardProps) {
  const status = post.status as keyof typeof statusConfig;
  const StatusIcon = statusConfig[status]?.icon || statusConfig.pending.icon;
  const statusClass = statusConfig[status]?.className || "";
  const statusLabel = statusConfig[status]?.label || post.status;
  const hasFailedPlatforms = post.platformResults?.some((r) => r.status === "failed");

  // Extract post types from metadata + platforms (handles Pinterest inference)
  const postTypes: string[] = (() => {
    const types: string[] = [];
    const metadata = post.metadata;
    if (metadata) {
      const fbType = metadata.facebook_post_type;
      if (fbType) { (Array.isArray(fbType) ? fbType : [fbType]).forEach((t: string) => { if (!types.includes(t)) types.push(t); }); }
      const igType = metadata.instagram_post_type || (metadata.instagram as any)?.mediaType;
      if (igType) { (Array.isArray(igType) ? igType : [igType]).forEach((t: string) => { if (!types.includes(t)) types.push(t); }); }
    }
    if (post.platforms?.includes("pinterest")) {
      let pinType: string | null = null;
      const stamped = metadata?.pinterest_post_type;
      if (typeof stamped === "string") {
        pinType = `${stamped} pin`;
      } else {
        const isVideo = !!metadata?.pinterest_is_video;
        const link = metadata?.pinterest_link || (metadata as any)?.pinterest?.link;
        const mediaCount = post.media_file_ids?.length || 0;
        if (isVideo) pinType = "video pin";
        else if (link) pinType = "link pin";
        else if (mediaCount > 1) pinType = "multi pin";
        else pinType = "image pin";
      }
      if (pinType && !types.includes(pinType)) types.push(pinType);
    }
    if (post.platforms?.includes("threads")) {
      const ids = post.media_file_ids || [];
      let t: string;
      if (ids.length === 0) t = "text";
      else if (ids.length > 1) t = "carousel";
      else {
        const isGif = !!metadata?.threads_is_gif;
        const isVideo = !!metadata?.threads_is_video;
        t = isGif ? "gif" : isVideo ? "video" : "image";
      }
      if (!types.includes(t)) types.push(t);
    }
    return types;
  })();

  return (
    <div
      data-testid="post-card"
      data-post-id={post.id}
      data-post-status={post.status}
      className={cn(
        "rounded-xl border-2 bg-card/50 backdrop-blur-sm overflow-hidden hover:bg-card transition-colors cursor-pointer",
        isSelected
          ? "border-primary ring-2 ring-primary/20"
          : "border-border hover:border-primary/50"
      )}
      onClick={() => onToggleSelection(post.id)}
    >
      <div className="p-5">
        <div className="flex items-start gap-4">
          {/* Selection Checkbox */}
          <div className={cn(
            "w-6 h-6 rounded-full flex items-center justify-center shrink-0 transition-all mt-0.5",
            isSelected
              ? "bg-primary text-primary-foreground"
              : "border-2 border-muted-foreground/30 hover:border-primary"
          )}>
            {isSelected && <CheckCircle2 className="w-4 h-4" />}
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <p className="text-sm line-clamp-2 mb-3">{post.caption || "No caption"}</p>
            <div className="flex flex-wrap items-center gap-3">
              <div className="flex items-center gap-1.5">
                {post.platforms.map((platform) => (
                  <PlatformIcon key={platform} platform={platform as Platform} size="sm" />
                ))}
              </div>
              {/* Source Badge */}
              {post.source === "api" ? (
                <Badge variant="outline" className="text-xs gap-1 border-blue-500/30 text-blue-500">
                  <Zap className="w-3 h-3" />
                  API
                </Badge>
              ) : (
                <Badge variant="outline" className="text-xs gap-1">
                  <MousePointer className="w-3 h-3" />
                  Manual
                </Badge>
              )}
              {postTypes.map((type) => (
                <span
                  key={type}
                  className={cn(
                    "text-xs font-medium px-1.5 py-0.5 rounded border capitalize",
                    type === "feed" ? "bg-emerald-400/10 text-emerald-500 border-emerald-500/20" :
                    type === "reel" ? "bg-purple-400/10 text-purple-500 border-purple-500/20" :
                    type === "story" ? "bg-amber-400/10 text-amber-500 border-amber-500/20" :
                    type === "image pin" ? "bg-rose-400/10 text-rose-500 border-rose-500/20" :
                    type === "video pin" ? "bg-red-400/10 text-red-500 border-red-500/20" :
                    type === "link pin" ? "bg-blue-400/10 text-blue-500 border-blue-500/20" :
                    type === "multi pin" ? "bg-indigo-400/10 text-indigo-500 border-indigo-500/20" :
                    type === "text" ? "bg-muted text-muted-foreground border-border" :
                    type === "image" ? "bg-emerald-400/10 text-emerald-500 border-emerald-500/20" :
                    type === "video" ? "bg-purple-400/10 text-purple-500 border-purple-500/20" :
                    type === "carousel" ? "bg-indigo-400/10 text-indigo-500 border-indigo-500/20" :
                    type === "gif" ? "bg-pink-400/10 text-pink-500 border-pink-500/20" :
                    "bg-muted text-muted-foreground"
                  )}
                >
                  {type}
                </span>
              ))}
              {post.media_file_ids && post.media_file_ids.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Image className="w-3 h-3" />
                  {post.media_file_ids.length} media
                </span>
              )}
              <span className="flex items-center gap-1 text-xs text-muted-foreground">
                <Clock className="w-3 h-3" />
                {formatDistanceToNow(new Date(post.created_at), { addSuffix: true })}
              </span>
            </div>
          </div>

          {/* Status & Actions */}
          <div className="flex items-center gap-3">
            <span
              className={cn(
                "flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full",
                statusClass
              )}
            >
              <StatusIcon className="w-3.5 h-3.5" />
              {statusLabel}
            </span>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-8 w-8"
                  onClick={(e) => e.stopPropagation()}
                  data-testid="post-menu"
                >
                  <MoreHorizontal className="w-4 h-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" onClick={(e) => e.stopPropagation()} data-testid="post-menu-content">
                <DropdownMenuItem
                  onClick={(e) => {
                    e.stopPropagation();
                    onViewDetails(post);
                  }}
                  className="gap-2"
                  data-testid="post-menu-view-details"
                >
                  <Eye className="w-4 h-4" />
                  View Details
                </DropdownMenuItem>
                {hasFailedPlatforms && (
                  <>
                    <DropdownMenuItem
                      onClick={() => onRetryFailed(post)}
                      disabled={isRetrying}
                      className="gap-2"
                      data-testid="post-menu-retry"
                    >
                      {isRetrying ? (
                        <Loader2 className="w-4 h-4 animate-spin" />
                      ) : (
                        <RefreshCw className="w-4 h-4" />
                      )}
                      Retry Failed
                    </DropdownMenuItem>
                    {hasTikTokMediaError && (
                      <DropdownMenuItem
                        onClick={() => onRetryWithMedia(post)}
                        className="gap-2"
                        data-testid="post-menu-retry-media"
                      >
                        <Upload className="w-4 h-4" />
                          {(post.media_file_ids?.length || 0) > 1 ? "Replace Carousel Media" : "Retry with New Video"}
                      </DropdownMenuItem>
                    )}
                  </>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onClick={() => onDelete(post)}
                  className="text-destructive gap-2"
                  data-testid="post-menu-delete"
                >
                  <Trash2 className="w-4 h-4" />
                  Delete
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>

        {/* Platform Results with Account Avatars */}
        {post.platformResults && post.platformResults.length > 0 && (
          <div className="mt-4 pt-4 border-t border-border">
            <div className="flex flex-wrap gap-2">
              {post.platformResults.map((result) => {
                const accountInfo = result.social_account_id
                  ? accountsCache[result.social_account_id]
                  : null;

                return (
                  <div
                    key={result.id}
                    className={cn(
                      "flex items-center gap-2 px-3 py-1.5 rounded-lg text-sm",
                      result.status === "success"
                        ? "bg-emerald-400/10"
                        : result.status === "pending_inbox"
                          ? "bg-blue-400/10"
                          : "bg-destructive/10"
                    )}
                  >
                    {/* Account Avatar */}
                    {accountInfo?.avatarUrl ? (
                      <img
                        src={accountInfo.avatarUrl}
                        alt={accountInfo.username || "Account"}
                        className="w-5 h-5 rounded-full object-cover border border-border"
                        loading="lazy"
                      />
                    ) : (
                      <PlatformIcon platform={result.platform as Platform} size="sm" />
                    )}

                    <span className="text-xs">
                      {accountInfo?.username || getPlatformName(result.platform as Platform)}
                      {result.response_data?.ig_post_subtype ? ` (${result.response_data.ig_post_subtype})` : ""}
                    </span>

                    {(() => {
                      const postUrl = buildPostUrl(
                        result.platform,
                        result.platform_post_id,
                        result.platform_post_url,
                        accountInfo?.username,
                        accountInfo?.tiktokUsername
                      );

                      if (result.status === "success" && postUrl) {
                        return (
                          <a
                            href={postUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            referrerPolicy="no-referrer"
                            className="text-primary hover:underline"
                            onClick={(e) => {
                              e.preventDefault();
                              e.stopPropagation();
                              openExternalPostUrl(postUrl);
                            }}
                          >
                            <ExternalLink className="w-3 h-3" />
                          </a>
                        );
                      } else if (result.status === "pending_inbox" || (result.status === "success" && result.platform === "tiktok" && !postUrl)) {
                        return (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="flex items-center gap-1 text-xs text-blue-400 cursor-help">
                                  <Inbox className="w-3 h-3" />
                                  Check inbox
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-xs">
                                <p>TikTok posts are sent to your TikTok inbox. Open the TikTok app and complete posting from there.</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        );
                      } else if (result.error_message) {
                        return (
                          <TooltipProvider>
                            <Tooltip>
                              <TooltipTrigger asChild>
                                <span className="text-xs text-destructive max-w-xs truncate cursor-help">
                                  {result.error_message.length > 30
                                    ? result.error_message.slice(0, 30) + "..."
                                    : result.error_message}
                                </span>
                              </TooltipTrigger>
                              <TooltipContent className="max-w-sm">
                                <p>{result.error_message}</p>
                              </TooltipContent>
                            </Tooltip>
                          </TooltipProvider>
                        );
                      }
                      return null;
                    })()}
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
