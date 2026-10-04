import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Platform } from "@/lib/types";
import { Send, Clock, Loader2, Eye, ArrowLeft } from "lucide-react";
import { PostPreview, PlatformIdentityMap } from "./PostPreview";
import { cn } from "@/lib/utils";

interface MediaFile {
  previewUrl: string;
  fileType: "image" | "video" | "gif";
  mediaSource?: "klipy" | "pexels" | "pixabay" | "giphy" | "unsplash" | "local";
  photographerName?: string;
  photographerUrl?: string;
  unsplashUrl?: string;
}

interface PostActionsProps {
  isPosting: boolean;
  isUploading: boolean;
  hasCharacterError: boolean;
  selectedAccountIds: string[];
  scheduleEnabled: boolean;
  scheduledAt: Date | null;
  selectedPlatforms: Platform[];
  caption: string;
  mediaFiles: MediaFile[];
  username?: string | null;
  platformIdentities?: PlatformIdentityMap;
  previewOpen: boolean;
  setPreviewOpen: (open: boolean) => void;
  onPost: () => void;
  onBack?: () => void;
  hasAttributionError?: boolean;
}

export function PostActions({
  isPosting,
  isUploading,
  hasCharacterError,
  selectedAccountIds,
  scheduleEnabled,
  scheduledAt,
  selectedPlatforms,
  caption,
  mediaFiles,
  username,
  platformIdentities,
  previewOpen,
  setPreviewOpen,
  onPost,
  onBack,
  hasAttributionError = false,
}: PostActionsProps) {
  const { t } = useTranslation("post");
  const isScheduleIncomplete = scheduleEnabled && !scheduledAt;
  const isDisabled = isPosting || isUploading || selectedAccountIds.length === 0 || hasCharacterError || isScheduleIncomplete || hasAttributionError;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 pt-4 border-t border-border">
      <div className="flex items-center gap-2">
        {onBack && (
          <Button
            variant="outline"
            onClick={onBack}
            className="gap-2"
          >
            <ArrowLeft className="w-4 h-4" />
            {t("common:back", "Back")}
          </Button>
        )}

        {selectedPlatforms.length > 0 && (
          <Dialog open={previewOpen} onOpenChange={setPreviewOpen}>
            <DialogTrigger asChild>
              <Button variant="outline" className="gap-2">
                <Eye className="w-4 h-4" />
                {t("actions.preview", "Preview")}
              </Button>
            </DialogTrigger>
            <DialogContent className="max-w-2xl max-h-[80vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{t("actions.postPreview", "Post Preview")}</DialogTitle>
              </DialogHeader>
              <PostPreview
                caption={caption}
                mediaFiles={mediaFiles}
                selectedPlatforms={selectedPlatforms}
                username={username || undefined}
                platformIdentities={platformIdentities}
              />
            </DialogContent>
          </Dialog>
        )}
      </div>

      <Button
        size="lg"
        className={cn(
          "w-full sm:w-auto sm:min-w-[180px] transition-all duration-200",
          isDisabled && "opacity-50"
        )}
        onClick={onPost}
        disabled={isDisabled}
      >
        {isPosting ? (
          <>
            <Loader2 className="w-4 h-4 me-2 animate-spin" />
            {scheduleEnabled ? t("actions.scheduling", "Scheduling...") : t("actions.publishing", "Publishing...")}
          </>
        ) : scheduleEnabled ? (
          <>
            <Clock className="w-4 h-4 me-2" />
            {scheduledAt ? t("actions.schedulePost", "Schedule Post") : t("actions.selectDateTime", "Select Date & Time")}
          </>
        ) : (
          <>
            <Send className="w-4 h-4 me-2" />
            {t("actions.postNow", "Post Now")}
          </>
        )}
      </Button>
    </div>
  );
}
