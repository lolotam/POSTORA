import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Platform } from "@/lib/types";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { getPostActivityTimestamp } from "@/lib/postActivity";
import { statusConfig, buildPostUrl } from "./historyUtils";
import { openExternalPostUrl } from "@/lib/openExternalPostUrl";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  MoreHorizontal,
  Loader2,
  RefreshCw,
  Eye,
  Trash2,
  Upload,
  ExternalLink,
  Zap,
  MousePointer,
  FileUp,
  Webhook,
  Send,
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
import { useTranslation } from "react-i18next";

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
  profileName: string | null;
  tiktokUsername?: string | null;
}

interface HistoryTableProps {
  posts: PostData[];
  selectedPosts: Set<string>;
  retryingPostId: string | null;
  accountsCache: Record<string, AccountInfo>;
  isRefetching?: boolean;
  onToggleSelection: (postId: string) => void;
  onSelectAll: () => void;
  onDeselectAll: () => void;
  onViewDetails: (post: PostData) => void;
  onRetryFailed: (post: PostData) => void;
  onRetryWithMedia: (post: PostData) => void;
  onDelete: (post: PostData) => void;
  isTikTokMediaError: (post: PostData) => boolean;
}

// Get request type icon and label
function getRequestType(source?: string, t?: (key: string, fallback: string) => string): { icon: React.ElementType; label: string; className: string } {
  switch (source) {
    case "api":
      return { icon: Zap, label: "API", className: "text-blue-500" };
    case "upload-media":
      return { icon: FileUp, label: t ? t("source.upload", "Upload") : "Upload", className: "text-foreground" };
    case "webhook":
      return { icon: Webhook, label: "Webhook", className: "text-orange-500" };
    default:
      return { icon: MousePointer, label: t ? t("source.manual", "Manual") : "Manual", className: "text-muted-foreground" };
  }
}

// Extract post types from metadata + platforms (handles Pinterest inference)
function getPostTypes(post: PostData): string[] {
  const metadata = post.metadata;
  const types: string[] = [];

  if (metadata) {
    const fbType = metadata.facebook_post_type;
    if (fbType) {
      const fbTypes = Array.isArray(fbType) ? fbType : [fbType];
      fbTypes.forEach((t: string) => { if (!types.includes(t)) types.push(t); });
    }

    const igType = metadata.instagram_post_type || metadata.instagram?.mediaType;
    if (igType) {
      const igTypes = Array.isArray(igType) ? igType : [igType];
      igTypes.forEach((t: string) => { if (!types.includes(t)) types.push(t); });
    }
  }

  // Pinterest: prefer server-stamped key, otherwise infer from media + link
  if (post.platforms?.includes("pinterest")) {
    let pinType: string | null = null;
    const stamped = metadata?.pinterest_post_type;
    if (typeof stamped === "string") {
      pinType = `${stamped} pin`;
    } else {
      const isVideo = !!metadata?.pinterest_is_video;
      const link = metadata?.pinterest_link || metadata?.pinterest?.link;
      const mediaCount = post.media_file_ids?.length || 0;
      if (isVideo) pinType = "video pin";
      else if (link) pinType = "link pin";
      else if (mediaCount > 1) pinType = "multi pin";
      else pinType = "image pin";
    }
    if (pinType && !types.includes(pinType)) types.push(pinType);
  }

  // Threads: infer from media count + metadata flags
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
}

function postTypeBadgeClass(type: string): string {
  switch (type) {
    case "feed": return "bg-emerald-400/10 text-emerald-500 border-emerald-500/20";
    case "reel": return "bg-muted text-foreground border-border";
    case "story": return "bg-amber-400/10 text-amber-500 border-amber-500/20";
    case "image pin": return "bg-rose-400/10 text-rose-500 border-rose-500/20";
    case "video pin": return "bg-red-400/10 text-red-500 border-red-500/20";
    case "link pin": return "bg-blue-400/10 text-blue-500 border-blue-500/20";
    case "multi pin": return "bg-muted text-foreground border-border";
    case "text": return "bg-muted text-muted-foreground border-border";
    case "image": return "bg-emerald-400/10 text-emerald-500 border-emerald-500/20";
    case "video": return "bg-muted text-foreground border-border";
    case "carousel": return "bg-muted text-foreground border-border";
    case "gif": return "bg-muted text-foreground border-border";
    default: return "bg-muted text-muted-foreground";
  }
}

export function HistoryTable({
  posts,
  selectedPosts,
  retryingPostId,
  accountsCache,
  isRefetching = false,
  onToggleSelection,
  onSelectAll,
  onDeselectAll,
  onViewDetails,
  onRetryFailed,
  onRetryWithMedia,
  onDelete,
  isTikTokMediaError,
}: HistoryTableProps) {
  const { t } = useTranslation("history");
  const allSelected = posts.length > 0 && selectedPosts.size === posts.length;
  const someSelected = selectedPosts.size > 0 && selectedPosts.size < posts.length;

  const getStatusLabel = (s: string) => {
    switch (s) {
      case "completed": return t("common:status.success", "Success");
      case "failed": return t("common:status.failed", "Failed");
      case "pending": return t("common:status.pending", "Pending");
      case "pending_inbox": return t("status.pendingInbox", "Check Inbox");
      case "processing": return t("common:status.processing", "Processing");
      default: return statusConfig[s as keyof typeof statusConfig]?.label || s;
    }
  };

  return (
    <div className="relative rounded-lg border border-border overflow-hidden">
      {/* Subtle refetching overlay */}
      {isRefetching && (
        <div className="absolute inset-0 bg-background z-10 flex items-center justify-center pointer-events-none">
          <div className="flex items-center gap-2 px-3 py-1.5 bg-background/90 rounded-full border border-border shadow-sm">
            <Loader2 className="w-4 h-4 animate-spin text-primary" />
            <span className="text-xs text-muted-foreground">{t("table.updating", "Updating...")}</span>
          </div>
        </div>
      )}
      <Table>
        <TableHeader>
          <TableRow className="bg-muted/50 hover:bg-muted/50">
            <TableHead className="w-12">
              <Checkbox
                checked={allSelected}
                ref={(ref) => {
                  if (ref) {
                    (ref as any).indeterminate = someSelected;
                  }
                }}
                onCheckedChange={(checked) => {
                  if (checked) {
                    onSelectAll();
                  } else {
                    onDeselectAll();
                  }
                }}
                aria-label={t("table.selectAll", "Select all")}
              />
            </TableHead>
            <TableHead className="w-28">{t("table.type", "Type")}</TableHead>
            <TableHead className="w-44">{t("table.activityDateTime", "Activity Date & Time")}</TableHead>
            
            <TableHead className="w-40">{t("table.account", "Account")}</TableHead>
            <TableHead className="w-28">{t("table.platform", "Platform")}</TableHead>
            <TableHead className="w-28">{t("table.postType", "Post Type")}</TableHead>
            <TableHead className="min-w-[100px] max-w-[180px]">{t("table.caption", "Caption")}</TableHead>
            <TableHead className="w-24">{t("table.status", "Status")}</TableHead>
            <TableHead className="min-w-[140px]">{t("table.postLink", "Post Link")}</TableHead>
            <TableHead className="w-20 text-end">{t("table.actions", "Actions")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {posts.map((post) => {
            const status = post.status as keyof typeof statusConfig;
            const StatusIcon = statusConfig[status]?.icon || statusConfig.pending.icon;
            const statusClass = statusConfig[status]?.className || "";
            const statusLabel = getStatusLabel(status);
            const hasFailedPlatforms = post.platformResults?.some((r) => r.status === "failed");
            const isRetrying = retryingPostId === post.id;
            const isSelected = selectedPosts.has(post.id);
            const requestType = getRequestType(post.source, t);
            const RequestIcon = requestType.icon;

            // Get unique accounts from platform results
            const uniqueAccounts = post.platformResults?.reduce((acc, result) => {
              if (result.social_account_id && !acc.find(a => a.id === result.social_account_id)) {
                const info = accountsCache[result.social_account_id];
                acc.push({
                  id: result.social_account_id,
                  username: info?.username || null,
                  avatarUrl: info?.avatarUrl || null,
                  profileName: info?.profileName || null,
                  platform: result.platform,
                });
              }
              return acc;
            }, [] as Array<{ id: string; username: string | null; avatarUrl: string | null; profileName: string | null; platform: string }>) || [];

            // Get unique profile names
            const uniqueProfileNames = [...new Set(uniqueAccounts.map(a => a.profileName).filter(Boolean))];

            // Get first successful post link
            const successfulResult = post.platformResults?.find((r) => r.status === "success");
            const accountInfo = successfulResult?.social_account_id
              ? accountsCache[successfulResult.social_account_id]
              : null;
            const postUrl = successfulResult
              ? buildPostUrl(
                  successfulResult.platform,
                  successfulResult.platform_post_id,
                  successfulResult.platform_post_url,
                  accountInfo?.username,
                  accountInfo?.tiktokUsername
                )
              : null;

            return (
              <TableRow
                key={post.id}
                data-testid="post-row"
                data-post-id={post.id}
                data-post-status={post.status}
                className={cn(
                  "cursor-pointer transition-colors",
                  isSelected && "bg-primary/5"
                )}
                onClick={() => onToggleSelection(post.id)}
              >
                <TableCell onClick={(e) => e.stopPropagation()}>
                  <Checkbox
                    checked={isSelected}
                    onCheckedChange={() => onToggleSelection(post.id)}
                    aria-label={t("table.selectPost", "Select post {{id}}", { id: post.id })}
                  />
                </TableCell>
                <TableCell>
                  <div className={cn("flex items-center gap-1.5 text-xs font-medium", requestType.className)}>
                    <RequestIcon className="w-3.5 h-3.5" />
                    {requestType.label}
                  </div>
                </TableCell>
                <TableCell className="text-xs text-muted-foreground whitespace-nowrap">
                  {format(new Date(getPostActivityTimestamp(post)), "MMM dd, yyyy HH:mm:ss")}
                </TableCell>
                <TableCell>
                  {uniqueAccounts.length > 0 ? (
                    <div className="flex items-center gap-1.5">
                      {uniqueAccounts.slice(0, 2).map((account) => (
                        <TooltipProvider key={account.id}>
                          <Tooltip>
                            <TooltipTrigger asChild>
                              <div className="flex items-center gap-1.5">
                                {account.avatarUrl ? (
                                  <img
                                    src={account.avatarUrl}
                                    alt={account.username || "Account"}
                                    className="w-5 h-5 rounded-full object-cover border border-border"
                                  />
                                ) : (
                                  <div className="w-5 h-5 rounded-full bg-muted flex items-center justify-center">
                                    <PlatformIcon platform={account.platform as Platform} size="xs" />
                                  </div>
                                )}
                              </div>
                            </TooltipTrigger>
                            <TooltipContent>
                              <p className="text-xs">{account.username || t("table.unknownAccount", "Unknown account")}</p>
                            </TooltipContent>
                          </Tooltip>
                        </TooltipProvider>
                      ))}
                      {uniqueAccounts.length > 2 && (
                        <span className="text-xs text-muted-foreground">+{uniqueAccounts.length - 2}</span>
                      )}
                      {uniqueAccounts.length === 1 && uniqueAccounts[0].username && (
                        <span className="text-xs truncate max-w-[80px]">{uniqueAccounts[0].username}</span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    {post.platforms.slice(0, 3).map((platform) => (
                      <PlatformIcon key={platform} platform={platform as Platform} size="sm" />
                    ))}
                    {post.platforms.length > 3 && (
                      <span className="text-xs text-muted-foreground">+{post.platforms.length - 3}</span>
                    )}
                  </div>
                </TableCell>
                <TableCell>
                  {(() => {
                    const postTypes = getPostTypes(post);
                    if (postTypes.length === 0) return <span className="text-xs text-muted-foreground">—</span>;
                    return (
                      <div className="flex flex-wrap gap-1">
                        {postTypes.map((type) => (
                          <span key={type} className={cn("text-xs font-medium px-1.5 py-0.5 rounded border capitalize", postTypeBadgeClass(type))}>
                            {type}
                          </span>
                        ))}
                      </div>
                    );
                  })()}
                </TableCell>
                <TableCell className="max-w-[200px]">
                  <TooltipProvider>
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <p className="text-sm truncate cursor-help">
                          {post.caption || <span className="text-muted-foreground italic">{t("common:noCaption", "No caption")}</span>}
                        </p>
                      </TooltipTrigger>
                      {post.caption && post.caption.length > 30 && (
                        <TooltipContent className="max-w-xs">
                          <p className="text-sm">{post.caption.slice(0, 100)}...</p>
                        </TooltipContent>
                      )}
                    </Tooltip>
                  </TooltipProvider>
                </TableCell>
                <TableCell>
                  <span
                    className={cn(
                      "inline-flex items-center gap-1 text-xs font-medium px-2 py-0.5 rounded-full",
                      statusClass
                    )}
                  >
                    <StatusIcon className="w-3 h-3" />
                    {statusLabel}
                  </span>
                </TableCell>
                <TableCell>
                  {post.platformResults && post.platformResults.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {post.platformResults.slice(0, 2).map((result) => {
                        const resultAccountInfo = result.social_account_id
                          ? accountsCache[result.social_account_id]
                          : null;
                        const resultUrl = buildPostUrl(
                          result.platform,
                          result.platform_post_id,
                          result.platform_post_url,
                          resultAccountInfo?.username
                        );

                        if (result.status === "success" && resultUrl) {
                          return (
                            <a
                              key={result.id}
                              href={resultUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              referrerPolicy="no-referrer"
                              className="flex items-center gap-1 text-xs text-primary hover:underline truncate max-w-[140px]"
                              onClick={(e) => {
                                e.preventDefault();
                                e.stopPropagation();
                                openExternalPostUrl(resultUrl);
                              }}
                            >
                              <PlatformIcon platform={result.platform as Platform} size="xs" />
                              <ExternalLink className="w-3 h-3 shrink-0" />
                              <span className="truncate">
                                {t("table.view", "View")}{result.response_data?.ig_post_subtype ? ` (${result.response_data.ig_post_subtype})` : ""}
                              </span>
                            </a>
                          );
                        } else if (result.status === "failed") {
                          return (
                            <TooltipProvider key={result.id}>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <span className="flex items-center gap-1 text-xs text-destructive cursor-help">
                                    <PlatformIcon platform={result.platform as Platform} size="xs" />
                                    <span className="truncate max-w-[100px]">
                                      {result.error_message?.slice(0, 20) || t("common:status.failed", "Failed")}
                                    </span>
                                  </span>
                                </TooltipTrigger>
                                <TooltipContent className="max-w-xs">
                                  <p>{result.error_message || t("table.postingFailed", "Posting failed")}</p>
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          );
                        } else if (result.status === "pending" || result.status === "pending_inbox") {
                          return (
                            <span key={result.id} className="flex items-center gap-1 text-xs text-muted-foreground">
                              <PlatformIcon platform={result.platform as Platform} size="xs" />
                              <span>{result.status === "pending_inbox" ? t("status.pendingInbox", "Check inbox") : t("common:status.pending", "Pending")}</span>
                            </span>
                          );
                        }
                        return null;
                      })}
                      {post.platformResults.length > 2 && (
                        <span className="text-xs text-muted-foreground">
                          {t("table.more", "+{{count}} more", { count: post.platformResults.length - 2 })}
                        </span>
                      )}
                    </div>
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell className="text-end" onClick={(e) => e.stopPropagation()}>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="h-8 w-8"
                        data-testid="post-menu"
                      >
                        <MoreHorizontal className="w-4 h-4" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end" data-testid="post-menu-content">
                      <DropdownMenuItem
                        onClick={() => onViewDetails(post)}
                        className="gap-2"
                        data-testid="post-menu-view-details"
                      >
                        <Eye className="w-4 h-4" />
                        {t("table.showDetails", "Show Details")}
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
                            {t("table.retryFailed", "Retry Failed")}
                          </DropdownMenuItem>
                          {isTikTokMediaError(post) && (
                            <DropdownMenuItem
                              onClick={() => onRetryWithMedia(post)}
                              className="gap-2"
                              data-testid="post-menu-retry-media"
                            >
                              <Upload className="w-4 h-4" />
                            {(post.media_file_ids?.length || 0) > 1
                              ? t("table.replaceCarouselMedia", "Replace Carousel Media")
                              : t("table.retryWithNewVideo", "Retry with New Video")}
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
                        {t("common:delete", "Delete")}
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
