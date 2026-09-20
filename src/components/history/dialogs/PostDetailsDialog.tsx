import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { openExternalPostUrl } from "@/lib/openExternalPostUrl";
import { ExternalLink, Maximize2, Download, DownloadCloud, RefreshCw, Loader2, AlertTriangle, RotateCcw, Type, Image as ImageIcon, Copy, Lightbulb, ChevronDown, ChevronUp, HardDrive, ShieldAlert, Clock, FileWarning, Wifi, Ban, Trash2 } from "lucide-react";
import type { PlatformPost } from "@/hooks/usePosts";
import { buildPostUrl } from "@/components/history/historyUtils";
import { useToast } from "@/hooks/use-toast";
import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { useFeatureFlags } from "@/hooks/useFeatureFlags";
import { useThreadsCapabilities } from "@/hooks/useThreadsCapabilities";
import { getErrorExplanation, type ErrorExplanation } from "@/components/history/errorExplanations";
import { LocationDebugView } from "@/components/history/LocationDebugView";
import { TopicTagDebugView } from "@/components/history/TopicTagDebugView";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface AccountInfo {
  username: string | null;
  avatarUrl: string | null;
  profileName: string | null;
  tiktokUsername?: string | null;
}

interface PostData {
  id: string;
  caption: string | null;
  platforms: string[];
  status: string | null;
  created_at: string;
  source?: string;
  platformResults?: PlatformPost[];
}

interface MediaPreview {
  id: string;
  url: string;
  kind: "image" | "video";
}

interface PostDetailsDialogProps {
  post: PostData | null;
  onClose: () => void;
  media: MediaPreview[];
  mediaLoading: boolean;
  accountsCache?: Record<string, AccountInfo>;
  onRetrySinglePlatform?: (
    postId: string, 
    platformPostId: string, 
    platform: string, 
    accountId?: string | null
  ) => Promise<void>;
  retryingPostId?: string | null;
  onDeletePlatformPost?: (platformPostRowId: string, platform: string) => Promise<void>;
}

export function PostDetailsDialog({
  post,
  onClose,
  media,
  accountsCache = {},
  onRetrySinglePlatform,
  retryingPostId,
  onDeletePlatformPost,
}: PostDetailsDialogProps) {
  const { t } = useTranslation("history");
  const { toast } = useToast();
  const navigate = useNavigate();
  const { flags } = useFeatureFlags();
  const { data: threadsCaps } = useThreadsCapabilities();
  const canDeleteThreadsPosts = threadsCaps?.canDeleteThreadsPosts ?? null;
  const [downloading, setDownloading] = useState(false);
  const [retryingPlatformId, setRetryingPlatformId] = useState<string | null>(null);
  const [pendingThreadsDeleteRowId, setPendingThreadsDeleteRowId] = useState<string | null>(null);
  const [deletingThreadsRowId, setDeletingThreadsRowId] = useState<string | null>(null);

  const handleReusePost = (mode: "caption" | "media" | "full") => {
    if (!post) return;
    const payload: Record<string, unknown> = { mode };
    if (mode === "caption" || mode === "full") {
      payload.caption = post.caption || "";
    }
    if (mode === "media" || mode === "full") {
      payload.media = media.map(m => ({ id: m.id, url: m.url, kind: m.kind }));
    }
    sessionStorage.setItem("postora_reuse_payload", JSON.stringify(payload));
    onClose();
    navigate("/post?from=reuse");
    const modeLabel =
      mode === "full"
        ? t("details.fullPost", "full post")
        : mode === "caption"
          ? t("details.caption", "caption")
          : t("details.media", "media");
    toast({
      title: t("details.postDataLoaded", "Post data loaded"),
      description: t("details.reusingMode", "Reusing {{mode}} in Post Creator", { mode: modeLabel }),
    });
  };

  const handleDownloadSingle = async (mediaItem: MediaPreview) => {
    try {
      const response = await fetch(mediaItem.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      const ext = mediaItem.kind === "video" ? "mp4" : "jpg";
      a.download = `media-${mediaItem.id.slice(0, 8)}.${ext}`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      console.error("Download error:", error);
      toast({
        title: t("details.downloadFailed", "Download failed"),
        description: t("details.downloadFailedDesc", "Could not download the file"),
        variant: "destructive",
      });
    }
  };

  const handleDownloadAll = async () => {
    if (media.length === 0) return;
    
    setDownloading(true);
    toast({
      title: t("details.downloading", "Downloading..."),
      description: t("details.downloadingCount", "Downloading {{count}} file(s)", { count: media.length }),
    });

    try {
      for (let i = 0; i < media.length; i++) {
        await handleDownloadSingle(media[i]);
        // Small delay between downloads
        if (i < media.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 300));
        }
      }
      toast({
        title: t("details.downloadComplete", "Download complete"),
        description: t("details.downloadSuccess", "Downloaded {{count}} file(s) successfully", { count: media.length }),
      });
    } catch (error) {
      console.error("Bulk download error:", error);
    } finally {
      setDownloading(false);
    }
  };

  return (
    <Dialog open={!!post} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t("details.title", "Post Details")}</DialogTitle>
          <DialogDescription>{t("details.subtitle", "View detailed information about this post")}</DialogDescription>
        </DialogHeader>

        {post && (
          <div className="space-y-6 pt-4">
            {/* Caption */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-2">{t("details.captionHeader", "Caption")}</h4>
              <p className="text-sm bg-secondary/50 rounded-lg p-3 whitespace-pre-wrap">
                {post.caption || t("common:noCaption", "No caption")}
              </p>
            </div>

            {/* Reuse Post Data */}
            {flags.reusePostData && (
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => handleReusePost("caption")} disabled={!post.caption}>
                  <Type className="w-3 h-3" /> {t("details.reuseCaption", "Reuse Caption")}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => handleReusePost("media")} disabled={media.length === 0}>
                  <ImageIcon className="w-3 h-3" /> {t("details.reuseMedia", "Reuse Media")}
                </Button>
                <Button size="sm" variant="outline" className="h-7 text-xs gap-1.5" onClick={() => handleReusePost("full")}>
                  <Copy className="w-3 h-3" /> {t("details.reuseFullPost", "Reuse Full Post")}
                </Button>
              </div>
            )}
            {media.length > 0 && (
              <div>
                <div className="flex items-center justify-between mb-2">
                  <h4 className="text-sm font-medium text-muted-foreground">{t("details.mediaHeader", "Media ({{count}})", { count: media.length })}</h4>
                  {media.length > 1 && (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={handleDownloadAll}
                      disabled={downloading}
                      className="h-7 text-xs"
                    >
                      <DownloadCloud className="w-3.5 h-3.5 mr-1.5" />
                      {downloading ? t("details.downloading", "Downloading...") : t("details.downloadAll", "Download All")}
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
                  {media.map((m) => (
                    <div key={m.id} className="relative rounded-lg overflow-hidden bg-black/5 dark:bg-white/5 group">
                      {m.kind === "video" ? (
                        <video
                          src={m.url}
                          className="w-full max-h-[300px] object-contain"
                          controls
                        />
                      ) : (
                        <img
                          src={m.url}
                          alt="Post media"
                          className="w-full max-h-[300px] object-contain"
                          loading="lazy"
                        />
                      )}
                      {/* Action buttons */}
                      <div className="absolute top-2 right-2 flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity">
                        <button
                          onClick={() => handleDownloadSingle(m)}
                          className="p-1.5 bg-black/50 hover:bg-black/70 rounded-lg transition-colors"
                          title="Download"
                        >
                          <Download className="w-4 h-4 text-white" />
                        </button>
                        <a
                          href={m.url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="p-1.5 bg-black/50 hover:bg-black/70 rounded-lg transition-colors"
                          title="View full size"
                        >
                          <Maximize2 className="w-4 h-4 text-white" />
                        </a>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Metadata */}
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">{t("details.created", "Created")}</span>
                <p className="font-medium">{format(new Date(post.created_at), "PPp")}</p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("table.status", "Status")}</span>
                <p className="font-medium capitalize">{post.status}</p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("details.source", "Source")}</span>
                <p className="font-medium capitalize">
                  {post.source === "upload"
                    ? t("source.upload", "Upload")
                    : post.source === "manual"
                      ? t("source.manual", "Manual")
                      : (post.source || t("source.manual", "Manual"))}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">{t("details.platforms", "Platforms")}</span>
                <div className="flex gap-1 mt-1">
                  {post.platforms.map((p) => (
                    <PlatformIcon key={p} platform={p as Platform} size="sm" />
                  ))}
                </div>
              </div>
            </div>

            {/* Platform Results */}
            <div>
              <h4 className="text-sm font-medium text-muted-foreground mb-3">{t("details.platformResults", "Platform Results")}</h4>
              <div className="space-y-2">
                {(() => {
                  const results = post.platformResults || [];
                  
                  // Find platforms that have zero results at all
                  const platformsWithResults = new Set<string>(results.map((r) => r.platform));
                  const missingPlatforms = post.platforms.filter(
                    (p) => !platformsWithResults.has(p)
                  );

                  if (results.length === 0 && missingPlatforms.length === 0) {
                    return <p className="text-sm text-muted-foreground">{t("details.noPlatformResults", "No platform results yet")}</p>;
                  }

                  return (
                    <>
                    {results.map((result) => (
                        <div
                          key={result.id}
                          className={cn(
                            "flex flex-col p-3 rounded-lg border gap-2",
                            result.status === "success"
                              ? "bg-emerald-400/5 border-emerald-400/20"
                              : result.status === "pending_inbox"
                                ? "bg-blue-400/5 border-blue-400/20"
                                : result.status === "pending"
                                  ? "bg-amber-400/5 border-amber-400/20"
                                  : "bg-destructive/5 border-destructive/20"
                          )}
                        >
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <PlatformIcon platform={result.platform as Platform} size="md" />
                              <div className="flex flex-col">
                                <div className="flex items-center gap-2">
                                  <span className="font-medium">{getPlatformName(result.platform as Platform)}</span>
                                  <Badge
                                    variant="secondary"
                                    className={cn(
                                      result.status === "success"
                                        ? "text-emerald-600 bg-emerald-400/10"
                                        : result.status === "pending_inbox"
                                          ? "text-blue-500 bg-blue-400/10"
                                          : result.status === "pending"
                                            ? "text-amber-600 bg-amber-400/10"
                                            : "text-destructive bg-destructive/10"
                                    )}
                                  >
                                    {result.status === "success" 
                                      ? t("common:status.success", "Success") 
                                      : result.status === "pending_inbox" 
                                        ? t("status.pendingInbox", "Check Inbox") 
                                        : result.status === "pending"
                                          ? t("common:status.pending", "Pending")
                                          : t("common:status.failed", "Failed")}
                                  </Badge>
                                </div>
                                {/* Account Info */}
                                {result.social_account_id && accountsCache[result.social_account_id] && (
                                  <div className="flex items-center gap-2 mt-1">
                                    <Avatar className="h-5 w-5">
                                      <AvatarImage src={accountsCache[result.social_account_id].avatarUrl || undefined} />
                                      <AvatarFallback className="text-[10px]">
                                        {(accountsCache[result.social_account_id].username || "?")[0]?.toUpperCase()}
                                      </AvatarFallback>
                                    </Avatar>
                                    <span className="text-xs text-muted-foreground">
                                      @{accountsCache[result.social_account_id].username || "unknown"}
                                    </span>
                                  </div>
                                )}
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              {(() => {
                                const accountInfo = result.social_account_id ? accountsCache[result.social_account_id] : null;
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
                                      className="text-primary hover:underline text-sm flex items-center gap-1"
                                      onClick={(e) => {
                                        e.preventDefault();
                                        e.stopPropagation();
                                        openExternalPostUrl(postUrl);
                                      }}
                                    >
                                      {t("details.viewPost", "View Post")} <ExternalLink className="w-3 h-3" />
                                    </a>
                                  );
                                }
                                return null;
                              })()}
                              
                              {/* Retry button for failed platforms */}
                              {result.status === "failed" && onRetrySinglePlatform && (
                                <Button
                                  size="sm"
                                  variant="outline"
                                  className="h-7 text-xs gap-1.5"
                                  disabled={retryingPostId === post.id || retryingPlatformId === result.id}
                                  onClick={async () => {
                                    setRetryingPlatformId(result.id);
                                    try {
                                      await onRetrySinglePlatform(
                                        post.id,
                                        result.id,
                                        result.platform,
                                        result.social_account_id
                                      );
                                    } finally {
                                      setRetryingPlatformId(null);
                                    }
                                  }}
                                >
                                  {retryingPlatformId === result.id ? (
                                    <Loader2 className="w-3 h-3 animate-spin" />
                                  ) : (
                                    <RefreshCw className="w-3 h-3" />
                                  )}
                                  {t("common:retry", "Retry")}
                                </Button>
                              )}

                              {/* Delete from Threads — only for Threads rows with a live platform_post_id */}
                              {result.platform === "threads" &&
                                result.platform_post_id &&
                                onDeletePlatformPost && (
                                  <TooltipProvider>
                                    <Tooltip>
                                      <TooltipTrigger asChild>
                                        <span>
                                          <Button
                                            size="sm"
                                            variant="outline"
                                            className="h-7 text-xs gap-1.5 text-destructive hover:text-destructive"
                                            disabled={
                                              canDeleteThreadsPosts === false ||
                                              deletingThreadsRowId === result.id
                                            }
                                            onClick={() => setPendingThreadsDeleteRowId(result.id)}
                                          >
                                            {deletingThreadsRowId === result.id ? (
                                              <Loader2 className="w-3 h-3 animate-spin" />
                                            ) : (
                                              <Trash2 className="w-3 h-3" />
                                            )}
                                            {t("details.deleteFromThreads", "Delete from Threads")}
                                          </Button>
                                        </span>
                                      </TooltipTrigger>
                                      <TooltipContent>
                                        {canDeleteThreadsPosts === false
                                          ? t("details.threadsDeleteTooltipNoPerm", "Reconnect Threads — your token doesn't include threads_delete")
                                          : canDeleteThreadsPosts === null
                                            ? t("details.threadsDeleteTooltipUnverified", "Not yet verified — will confirm on attempt")
                                            : t("details.threadsDeleteTooltipVerified", "Delete this post from Threads (Meta)")}
                                      </TooltipContent>
                                    </Tooltip>
                                  </TooltipProvider>
                                )}
                            </div>
                          </div>
                          {result.error_message && (() => {
                            const explanation = getErrorExplanation(result.error_message, result.platform);
                            const iconMap: Record<string, React.ReactNode> = {
                              size: <HardDrive className="w-4 h-4" />,
                              auth: <ShieldAlert className="w-4 h-4" />,
                              rate: <Clock className="w-4 h-4" />,
                              format: <FileWarning className="w-4 h-4" />,
                              network: <Wifi className="w-4 h-4" />,
                              permission: <Ban className="w-4 h-4" />,
                            };

                            return explanation ? (
                              <div className="space-y-2">
                                {/* User-friendly explanation */}
                                <div className="bg-amber-500/10 border border-amber-500/20 rounded-md p-3 text-xs space-y-2">
                                  <div className="flex items-start gap-2">
                                    <span className="text-amber-600 mt-0.5 shrink-0">{iconMap[explanation.icon] || <AlertTriangle className="w-4 h-4" />}</span>
                                    <div>
                                      <p className="font-semibold text-amber-700 dark:text-amber-400">{explanation.title}</p>
                                      <p className="text-muted-foreground mt-1">{explanation.explanation}</p>
                                    </div>
                                  </div>
                                  <div className="flex items-start gap-2 bg-background/60 rounded p-2">
                                    <Lightbulb className="w-3.5 h-3.5 text-primary mt-0.5 shrink-0" />
                                    <p className="text-foreground/80"><span className="font-medium">{t("details.recommendation", "Recommendation:")}</span> {explanation.recommendation}</p>
                                  </div>
                                </div>
                                {/* Collapsible technical error */}
                                <Collapsible>
                                  <CollapsibleTrigger className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors">
                                    <ChevronDown className="w-3 h-3" />
                                    {t("details.showTechnicalDetails", "Show technical details")}
                                  </CollapsibleTrigger>
                                  <CollapsibleContent>
                                    <div className="bg-destructive/10 rounded-md p-2 text-[10px] text-destructive break-words mt-1 font-mono">
                                      {result.error_message}
                                    </div>
                                  </CollapsibleContent>
                                </Collapsible>
                              </div>
                            ) : (
                              <div className="bg-destructive/10 rounded-md p-2.5 text-xs text-destructive break-words">
                                <span className="font-medium">{t("details.errorLabel", "Error:")} </span>
                                {result.error_message}
                              </div>
                            );
                          })()}
                          {/* Warnings (e.g., collaborator skipped) */}
                          {result.response_data?.warnings && (result.response_data.warnings as string[]).length > 0 && (
                            <div className="space-y-1">
                              {(result.response_data.warnings as string[]).map((warning, idx) => (
                                <div key={idx} className="bg-amber-500/10 rounded-md p-2.5 text-xs text-amber-700 dark:text-amber-400 break-words flex items-start gap-2">
                                  <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                  <span>{warning}</span>
                                </div>
                              ))}
                            </div>
                          )}
                          {/* Location debug (Instagram + Threads) */}
                          {(result.response_data as Record<string, unknown> | undefined)?.location_debug != null && (
                            <LocationDebugView
                              debug={
                                (result.response_data as Record<string, unknown>)
                                  .location_debug as Parameters<typeof LocationDebugView>[0]["debug"]
                              }
                            />
                          )}
                          {/* Topic tag debug (Threads only) */}
                          {result.platform === "threads" &&
                            (result.response_data as Record<string, unknown> | undefined)?.topic_tag_debug != null && (
                              <TopicTagDebugView
                                debug={
                                  (result.response_data as Record<string, unknown>)
                                    .topic_tag_debug as Parameters<typeof TopicTagDebugView>[0]["debug"]
                                }
                              />
                            )}
                        </div>
                      ))}


                    {/* Platforms with NO results at all */}
                    {missingPlatforms.map((platform) => (
                      <div
                        key={`missing-${platform}`}
                        className="flex flex-col p-3 rounded-lg border gap-2 bg-muted/30 border-muted-foreground/20"
                      >
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <PlatformIcon platform={platform as Platform} size="md" />
                            <div className="flex flex-col">
                              <div className="flex items-center gap-2">
                                <span className="font-medium">{getPlatformName(platform as Platform)}</span>
                                <Badge
                                  variant="secondary"
                                  className="text-muted-foreground bg-muted"
                                >
                                  {t("details.noRecord", "No Record")}
                                </Badge>
                              </div>
                              <span className="text-xs text-muted-foreground mt-0.5">
                                {platform === "tiktok" 
                                  ? t("details.tiktokProcessing", "TikTok video may still be processing") 
                                  : t("details.noRecordFound", "No publishing record found for this platform")}
                              </span>
                            </div>
                          </div>
                        </div>
                      </div>
                    ))}
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </DialogContent>

      {/* Confirm dialog for per-row Delete from Threads */}
      <AlertDialog
        open={!!pendingThreadsDeleteRowId}
        onOpenChange={(open) => !open && setPendingThreadsDeleteRowId(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("details.deleteThreadsDialogTitle", "Delete this post from Threads?")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("details.deleteThreadsDialogDesc", "This removes the post from Meta. Your local history record stays so you can still see it here.")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
              onClick={async () => {
                const rowId = pendingThreadsDeleteRowId;
                setPendingThreadsDeleteRowId(null);
                if (!rowId || !onDeletePlatformPost) return;
                setDeletingThreadsRowId(rowId);
                try {
                  await onDeletePlatformPost(rowId, "threads");
                } finally {
                  setDeletingThreadsRowId(null);
                }
              }}
            >
              {t("details.deleteFromThreads", "Delete from Threads")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Dialog>
  );
}
