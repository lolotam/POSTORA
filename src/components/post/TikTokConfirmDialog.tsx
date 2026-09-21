// ═══════════════════════════════════════════════════════════════════════════
// TikTok Confirmation Dialog
// Explicit consent before posting (Section 5a & 5c compliance)
// ═══════════════════════════════════════════════════════════════════════════

import { useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import { 
  Loader2, 
  CheckCircle2, 
  Clock, 
  Eye,
  Users,
  Lock,
  MessageCircle,
  Repeat2,
  Scissors,
  AlertTriangle,
  Video,
  Image as ImageIcon,
  Sparkles,
  Tag,
} from "lucide-react";
import { cn } from "@/lib/utils";
import type { TikTokCreatorInfo } from "./settings/TikTokSettings";

interface TikTokConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
  isPosting: boolean;
  
  // Media info
  mediaFiles: Array<{
    previewUrl?: string;
    fileType: "image" | "video" | "gif";
    file?: File;
  }>;
  caption: string;
  
  // Settings
  privacyLevel: string;
  allowComment: boolean;
  allowDuet: boolean;
  allowStitch: boolean;
  discloseContent: boolean;
  yourBrand: boolean;
  brandedContent: boolean;
  aiGenerated: boolean;
  
  // Creator info
  creatorInfo: TikTokCreatorInfo | null;
}

export function TikTokConfirmDialog({
  open,
  onOpenChange,
  onConfirm,
  isPosting,
  mediaFiles,
  caption,
  privacyLevel,
  allowComment,
  allowDuet,
  allowStitch,
  discloseContent,
  yourBrand,
  brandedContent,
  aiGenerated,
  creatorInfo,
}: TikTokConfirmDialogProps) {
  const { t } = useTranslation(["postpreview", "common"]);
  const isVideo = mediaFiles.some(f => f.fileType === "video");
  const previewMedia = mediaFiles[0];
  
  // Estimate processing time based on file size
  const estimatedTime = useMemo(() => {
    if (!isVideo) return t("postpreview:tikTokConfirm.time30s", "~30 seconds");
    
    const videoFile = mediaFiles.find(f => f.fileType === "video")?.file;
    if (!videoFile) return t("postpreview:tikTokConfirm.time1to2m", "1-2 minutes");
    
    const sizeMB = videoFile.size / (1024 * 1024);
    
    if (sizeMB < 512) return t("postpreview:tikTokConfirm.time30s", "~30 seconds");
    if (sizeMB < 1024) return t("postpreview:tikTokConfirm.time1m", "~1 minute");
    if (sizeMB < 2048) return t("postpreview:tikTokConfirm.time1to2m", "~1-2 minutes");
    return t("postpreview:tikTokConfirm.time2mPlus", "2+ minutes");
  }, [isVideo, mediaFiles, t]);

  const privacyInfo = useMemo(() => {
    switch (privacyLevel) {
      case "PUBLIC_TO_EVERYONE":
        return { label: t("postpreview:tikTokConfirm.privacyEveryone", "Everyone"), icon: Users, color: "text-green-600" };
      case "MUTUAL_FOLLOW_FRIENDS":
        return { label: t("postpreview:tikTokConfirm.privacyFriends", "Friends only"), icon: Users, color: "text-blue-600" };
      case "SELF_ONLY":
        return { label: t("postpreview:tikTokConfirm.privacyOnlyMe", "Only me"), icon: Lock, color: "text-amber-600" };
      case "FOLLOWER_OF_CREATOR":
        return { label: t("postpreview:tikTokConfirm.privacyFollowers", "Followers"), icon: Eye, color: "text-purple-600" };
      default:
        return { label: privacyLevel, icon: Eye, color: "text-muted-foreground" };
    }
  }, [privacyLevel, t]);

  const getContentLabel = () => {
    if (brandedContent) return t("postpreview:tikTokPost.paidPartnership", "Paid partnership");
    if (yourBrand) return t("postpreview:tikTokPost.promotionalContent", "Promotional content");
    return null;
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent className="max-w-md">
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-[#00f2ea] to-[#ff0050] flex items-center justify-center">
              <span className="text-white text-xs font-bold">TT</span>
            </div>
            {t("postpreview:tikTokConfirm.title", "Confirm TikTok Post")}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-4">
              {/* Account Info */}
              <div className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg">
                {creatorInfo?.creator_avatar_url ? (
                  <img 
                    src={creatorInfo.creator_avatar_url} 
                    alt="" 
                    className="w-10 h-10 rounded-full object-cover"
                  />
                ) : (
                  <div className="w-10 h-10 rounded-full bg-gradient-to-br from-[#00f2ea] to-[#ff0050]" />
                )}
                <div>
                  <p className="font-medium text-foreground">
                    @{creatorInfo?.creator_username || creatorInfo?.creator_nickname || t("postpreview:tikTokConfirm.defaultAccount", "Your account")}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {isVideo ? t("postpreview:tikTokConfirm.videoPost", "Video post") : t("postpreview:tikTokConfirm.photoPost", "Photo post")}
                  </p>
                </div>
                <Badge variant="secondary" className="ms-auto">
                  {isVideo ? <Video className="w-3 h-3 me-1" /> : <ImageIcon className="w-3 h-3 me-1" />}
                  {t("postpreview:tikTokConfirm.filesCount", { count: mediaFiles.length, defaultValue: `${mediaFiles.length} ${mediaFiles.length === 1 ? "file" : "files"}` })}
                </Badge>
              </div>

              {/* Settings Summary */}
              <div className="space-y-2 text-sm">
                <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <privacyInfo.icon className="w-4 h-4" />
                    {t("postpreview:tikTokConfirm.privacy", "Privacy")}
                  </span>
                  <span className={cn("font-medium", privacyInfo.color)}>
                    {privacyInfo.label}
                  </span>
                </div>

                <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                  <span className="text-muted-foreground flex items-center gap-2">
                    <MessageCircle className="w-4 h-4" />
                    {t("postpreview:tikTokConfirm.comments", "Comments")}
                  </span>
                  <span className={allowComment ? "text-green-600 font-medium" : "text-muted-foreground"}>
                    {allowComment ? t("postpreview:tikTokConfirm.enabled", "Enabled") : t("postpreview:tikTokConfirm.disabled", "Disabled")}
                  </span>
                </div>

                {isVideo && (
                  <>
                    <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Repeat2 className="w-4 h-4" />
                        {t("postpreview:tikTokConfirm.duet", "Duet")}
                      </span>
                      <span className={allowDuet ? "text-green-600 font-medium" : "text-muted-foreground"}>
                        {allowDuet ? t("postpreview:tikTokConfirm.enabled", "Enabled") : t("postpreview:tikTokConfirm.disabled", "Disabled")}
                      </span>
                    </div>

                    <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                      <span className="text-muted-foreground flex items-center gap-2">
                        <Scissors className="w-4 h-4" />
                        {t("postpreview:tikTokConfirm.stitch", "Stitch")}
                      </span>
                      <span className={allowStitch ? "text-green-600 font-medium" : "text-muted-foreground"}>
                        {allowStitch ? t("postpreview:tikTokConfirm.enabled", "Enabled") : t("postpreview:tikTokConfirm.disabled", "Disabled")}
                      </span>
                    </div>
                  </>
                )}

                {aiGenerated && (
                  <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <Sparkles className="w-4 h-4" />
                      {t("postpreview:tikTokConfirm.aiLabel", "AI Label")}
                    </span>
                    <span className="text-primary font-medium">{t("postpreview:tikTokConfirm.enabled", "Enabled")}</span>
                  </div>
                )}

                {getContentLabel() && (
                  <div className="flex items-center justify-between py-1.5 border-b border-border/50">
                    <span className="text-muted-foreground flex items-center gap-2">
                      <Tag className="w-4 h-4" />
                      {t("postpreview:tikTokConfirm.disclosure", "Disclosure")}
                    </span>
                    <span className="text-primary font-medium">{getContentLabel()}</span>
                  </div>
                )}

                {/* Caption Preview */}
                {caption && (
                  <div className="pt-2">
                    <p className="text-xs text-muted-foreground mb-1">{t("postpreview:tikTokConfirm.captionLabel", "Caption:")}</p>
                    <p className="text-sm line-clamp-2 bg-muted/30 p-2 rounded">
                      {caption}
                    </p>
                  </div>
                )}
              </div>

              {/* Processing Time Warning */}
              <div className="p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
                <div className="flex items-start gap-2">
                  <AlertTriangle className="w-4 h-4 text-amber-600 flex-shrink-0 mt-0.5" />
                  <div className="space-y-1">
                    <p className="text-sm text-amber-800 dark:text-amber-200">
                      {t("postpreview:tikTokConfirm.processingTimeMayTake", { estimatedTime, defaultValue: `Processing may take ${estimatedTime}` })}
                    </p>
                    <p className="text-xs text-amber-700/80 dark:text-amber-300/80">
                      {t("postpreview:tikTokConfirm.processingDescription", "After uploading, TikTok needs time to process your content. Moderation may take an additional 1-2 minutes.")}
                    </p>
                  </div>
                </div>
              </div>

              {/* Inbox Reminder */}
              <div className="p-3 bg-blue-500/10 border border-blue-500/30 rounded-lg">
                <div className="flex items-start gap-2">
                  <Clock className="w-4 h-4 text-blue-600 flex-shrink-0 mt-0.5" />
                  <div>
                    <p className="text-sm text-blue-800 dark:text-blue-200">
                      {t("postpreview:tikTokConfirm.inboxTitle", "Check your TikTok inbox")}
                    </p>
                    <p className="text-xs text-blue-700/80 dark:text-blue-300/80">
                      {t("postpreview:tikTokConfirm.inboxDescription", "The post will be sent to your TikTok inbox for final review before publishing.")}
                    </p>
                  </div>
                </div>
              </div>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>

        <AlertDialogFooter className="gap-2 sm:gap-0">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPosting}
          >
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            onClick={onConfirm}
            disabled={isPosting}
            className="bg-[#fe2c55] hover:bg-[#fe2c55]/90"
          >
            <AnimatePresence mode="wait">
              {isPosting ? (
                <motion.span
                  key="loading"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2"
                >
                  <Loader2 className="w-4 h-4 animate-spin" />
                  {t("postpreview:tikTokConfirm.uploading", "Uploading...")}
                </motion.span>
              ) : (
                <motion.span
                  key="confirm"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  className="flex items-center gap-2"
                >
                  <CheckCircle2 className="w-4 h-4" />
                  {t("postpreview:tikTokConfirm.confirmPost", "Confirm Post")}
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
