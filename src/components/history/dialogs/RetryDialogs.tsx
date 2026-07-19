import { useRef } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { PlatformIcon, getPlatformName } from "@/components/PlatformIcon";
import { Platform } from "@/lib/types";
import { cn } from "@/lib/utils";
import { CheckCircle2, FileImage, FileVideo, Loader2, RefreshCw, Upload } from "lucide-react";

interface AccountInfo {
  username: string | null;
  avatarUrl: string | null;
}

interface PlatformResult {
  id: string;
  platform: string;
  status: string | null;
  social_account_id?: string | null;
}

interface PostData {
  id: string;
  media_file_ids?: string[] | null;
  platformResults?: PlatformResult[];
}

interface RetryAccountDialogProps {
  post: PostData | null;
  onClose: () => void;
  selectedAccountIds: string[];
  onToggleAccount: (accountId: string) => void;
  onRetry: () => void;
  isLoading: boolean;
  accountsCache: Record<string, AccountInfo>;
}

export function RetryAccountDialog({
  post,
  onClose,
  selectedAccountIds,
  onToggleAccount,
  onRetry,
  isLoading,
  accountsCache,
}: RetryAccountDialogProps) {
  return (
    <Dialog open={!!post} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Retry Failed Post</DialogTitle>
          <DialogDescription>
            TikTok requires you to confirm which account(s) to retry.
          </DialogDescription>
        </DialogHeader>

        {post && (
          <div className="space-y-4">
            <div className="space-y-2">
              <h4 className="text-sm font-medium text-muted-foreground">Failed Platforms</h4>
              <div className="flex flex-wrap gap-2">
                {post.platformResults
                  ?.filter((r) => r.status === "failed")
                  .map((result) => {
                    const accountInfo = result.social_account_id
                      ? accountsCache[result.social_account_id]
                      : null;
                    const isSelected = result.social_account_id
                      ? selectedAccountIds.includes(result.social_account_id)
                      : false;

                    return (
                      <button
                        key={result.id}
                        onClick={() => {
                          if (result.social_account_id) {
                            onToggleAccount(result.social_account_id);
                          }
                        }}
                        className={cn(
                          "flex items-center gap-2 px-3 py-2 rounded-lg border transition-colors",
                          isSelected
                            ? "bg-primary/10 border-primary/30"
                            : "bg-secondary/50 border-border hover:bg-secondary"
                        )}
                      >
                        {accountInfo?.avatarUrl ? (
                          <img
                            src={accountInfo.avatarUrl}
                            alt={accountInfo.username || "Account"}
                            className="w-6 h-6 rounded-full object-cover"
                          />
                        ) : (
                          <PlatformIcon platform={result.platform as Platform} size="sm" />
                        )}
                        <span className="text-sm">
                          {accountInfo?.username || getPlatformName(result.platform as Platform)}
                        </span>
                        {isSelected && <CheckCircle2 className="w-4 h-4 text-primary" />}
                      </button>
                    );
                  })}
              </div>
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={onClose}
                disabled={isLoading}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={onRetry}
                disabled={isLoading || selectedAccountIds.length === 0}
              >
                {isLoading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Retrying...
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-4 h-4 mr-2" />
                    Retry ({selectedAccountIds.length})
                  </>
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

interface RetryMediaDialogProps {
  post: PostData | null;
  onClose: () => void;
  mediaFiles: File[];
  onMediaChange: (files: File[]) => void;
  onRetry: () => void;
  isUploading: boolean;
}

export function RetryMediaDialog({
  post,
  onClose,
  mediaFiles,
  onMediaChange,
  onRetry,
  isUploading,
}: RetryMediaDialogProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const isCarousel = (post?.media_file_ids?.length || 0) > 1;
  const selectedMediaLabel = isCarousel ? `${mediaFiles.length} image${mediaFiles.length === 1 ? "" : "s"} selected` : mediaFiles[0]?.name;

  return (
    <Dialog open={!!post} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {isCarousel ? <FileImage className="w-5 h-5" /> : <FileVideo className="w-5 h-5" />}
            {isCarousel ? "Replace Carousel Media" : "Retry with New Video"}
          </DialogTitle>
          <DialogDescription>
            {isCarousel
              ? "Upload 2 to 10 replacement images. They will replace the unavailable carousel media."
              : "Upload a new vertical 9:16 video (720×1280 or higher)."}
          </DialogDescription>
        </DialogHeader>

        {post && (
          <div className="space-y-4">
            <div
              className={cn(
                "border-2 border-dashed rounded-lg p-6 text-center transition-colors cursor-pointer",
                mediaFiles.length > 0
                  ? "border-primary/50 bg-primary/5"
                  : "border-border hover:border-primary/30 hover:bg-muted/50"
              )}
              onClick={() => inputRef.current?.click()}
            >
              <input
                ref={inputRef}
                type="file"
                accept={isCarousel ? "image/jpeg,image/png,image/webp" : "video/mp4,video/quicktime,video/mov"}
                multiple={isCarousel}
                className="hidden"
                onChange={(e) => {
                  onMediaChange(Array.from(e.target.files || []));
                }}
              />

              {mediaFiles.length > 0 ? (
                <div className="space-y-2">
                  {isCarousel ? <FileImage className="w-10 h-10 mx-auto text-primary" /> : <FileVideo className="w-10 h-10 mx-auto text-primary" />}
                  <p className="font-medium">{selectedMediaLabel}</p>
                  <p className="text-sm text-muted-foreground">
                    {(mediaFiles.reduce((total, file) => total + file.size, 0) / 1024 / 1024).toFixed(2)} MB total
                  </p>
                </div>
              ) : (
                <div className="space-y-2">
                  <Upload className="w-10 h-10 mx-auto text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">
                    {isCarousel ? "Click to select 2 to 10 image files" : "Click to select a video file"}
                  </p>
                </div>
              )}
            </div>

            <div className="flex gap-3 pt-2">
              <Button
                variant="outline"
                className="flex-1"
                onClick={() => {
                  onClose();
                  onMediaChange([]);
                }}
                disabled={isUploading}
              >
                Cancel
              </Button>
              <Button
                className="flex-1"
                onClick={onRetry}
                disabled={isUploading || mediaFiles.length === 0 || (isCarousel && (mediaFiles.length < 2 || mediaFiles.length > 10))}
              >
                {isUploading ? (
                  <>
                    <Loader2 className="w-4 h-4 animate-spin mr-2" />
                    Uploading...
                  </>
                ) : (
                  isCarousel ? "Retry with Replacement Images" : "Retry with New Video"
                )}
              </Button>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
