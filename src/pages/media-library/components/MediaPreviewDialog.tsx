import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import {
  X,
  Calendar,
  HardDrive,
  FileType,
  Download,
  Link,
  Trash2,
  Move,
  Pencil,
  Share2,
  RefreshCw,
  Wand2,
  Scissors,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { PlatformIcon } from "@/components/PlatformIcon";
import { MediaFile, SocialAccount } from "../types";
import { formatFileSize } from "../utils";
import { getFileDisplayName } from "@/components/media";
import { FileTypeTile } from "@/components/media/FileTypeTile";
import { libraryFilePresentation } from "@/lib/mediaTypes";

interface MediaPreviewDialogProps {
  file: MediaFile | null;
  socialAccounts: SocialAccount[];
  onClose: () => void;
  onDownload: (file: MediaFile) => void;
  onCopyLink: (file: MediaFile) => void;
  onDelete: (fileId: string) => void;
  onMove: (fileId: string) => void;
  onRename: (file: MediaFile) => void;
  onShare: (file: MediaFile) => void;
  onReplace: (file: MediaFile) => void;
  onImageTools: (file: MediaFile) => void;
  onBgRemoval: (file: MediaFile) => void;
}

export function MediaPreviewDialog({
  file,
  socialAccounts,
  onClose,
  onDownload,
  onCopyLink,
  onDelete,
  onMove,
  onRename,
  onShare,
  onReplace,
  onImageTools,
  onBgRemoval,
}: MediaPreviewDialogProps) {
  const { t } = useTranslation("assets");
  if (!file) return null;
  const presentation = libraryFilePresentation(file);
  const isImage = file.file_type === "image" || file.file_type === "gif";
  const isPdf = presentation.extension === "pdf" || file.mime_type === "application/pdf";

  const getAccountInfo = (accountId: string) => {
    return socialAccounts.find((a) => a.id === accountId);
  };

  return (
    <Dialog open={!!file} onOpenChange={() => onClose()}>
      <DialogContent className="max-w-4xl max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center justify-between pe-8">
            <span className="truncate">{getFileDisplayName(file)}</span>
          </DialogTitle>
        </DialogHeader>
        <div className="flex-1 overflow-auto">
          <div className="grid md:grid-cols-2 gap-6">
            <div className="bg-muted rounded-lg overflow-hidden flex items-center justify-center min-h-[300px]">
              {isImage ? (
                <img
                  src={file.publicUrl}
                  alt=""
                  className="max-w-full max-h-[60vh] object-contain"
                />
              ) : file.file_type === "video" ? (
                <video
                  src={file.publicUrl}
                  controls
                  className="max-w-full max-h-[60vh]"
                />
              ) : presentation.kind === "audio" ? (
                <audio src={file.publicUrl} controls className="w-full" />
              ) : (
                <FileTypeTile kind={presentation.kind} icon={presentation.icon} extension={presentation.extension} className="min-h-[240px]" />
              )}
            </div>
            <div className="space-y-4">
              <div>
                <h3 className="font-semibold mb-2">File Details</h3>
                <div className="space-y-2 text-sm">
                  <div className="flex items-center gap-2">
                    <FileType className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Type:</span>
                    <Badge variant="secondary">{file.file_type}</Badge>
                  </div>
                  <div className="flex items-center gap-2">
                    <HardDrive className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Size:</span>
                    <span>{formatFileSize(file.file_size)}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <Calendar className="w-4 h-4 text-muted-foreground" />
                    <span className="text-muted-foreground">Uploaded:</span>
                    <span>
                      {format(new Date(file.created_at), "MMM d, yyyy 'at' h:mm a")}
                    </span>
                  </div>
                </div>
              </div>

              {file.linked_account_ids && file.linked_account_ids.length > 0 && (
                <div>
                  <h3 className="font-semibold mb-2">Used by Accounts</h3>
                  <div className="flex flex-wrap gap-2">
                    {file.linked_account_ids.map((accountId) => {
                      const account = getAccountInfo(accountId);
                      if (!account) return null;
                      return (
                        <Badge
                          key={accountId}
                          variant="outline"
                          className="gap-1"
                        >
                          <PlatformIcon
                            platform={account.platform as any}
                            size="sm"
                          />
                          {account.platform_username}
                        </Badge>
                      );
                    })}
                  </div>
                </div>
              )}

              <div>
                <h3 className="font-semibold mb-2">Actions</h3>
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onDownload(file)}
                  >
                    <Download className="w-4 h-4 me-2" />
                    Download
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onCopyLink(file)}
                  >
                    <Link className="w-4 h-4 me-2" />
                    Copy Link
                  </Button>
                  {isPdf && (
                    <Button variant="outline" size="sm" asChild>
                      <a href={file.publicUrl} target="_blank" rel="noopener noreferrer">
                        {t("preview.openPdf", "Open in a new tab")}
                      </a>
                    </Button>
                  )}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onRename(file)}
                  >
                    <Pencil className="w-4 h-4 me-2" />
                    Rename
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onShare(file)}
                  >
                    <Share2 className="w-4 h-4 me-2" />
                    Share
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onMove(file.id)}
                  >
                    <Move className="w-4 h-4 me-2" />
                    Move
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onReplace(file)}
                  >
                    <RefreshCw className="w-4 h-4 me-2" />
                    Replace
                  </Button>
                  {isImage && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onImageTools(file)}
                      >
                        <Wand2 className="w-4 h-4 me-2" />
                        Image Tools
                      </Button>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => onBgRemoval(file)}
                      >
                        <Scissors className="w-4 h-4 me-2" />
                        Remove BG
                      </Button>
                    </>
                  )}
                  <Button
                    variant="destructive"
                    size="sm"
                    onClick={() => {
                      onClose();
                      onDelete(file.id);
                    }}
                  >
                    <Trash2 className="w-4 h-4 me-2" />
                    Delete
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
