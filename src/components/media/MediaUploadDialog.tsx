import { useState, useCallback, useEffect } from "react";
import { Trans, useTranslation } from "react-i18next";
import { useDropzone } from "react-dropzone";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useQuotas } from "@/hooks/useQuotas";
import { useLogMediaOperation } from "@/hooks/useMediaOperationsHistory";
import { UpgradePromptModal } from "@/components/UpgradePromptModal";
import {
  Upload,
  X,
  FileImage,
  FileVideo,
  Check,
  Download,
  Loader2,
  ExternalLink,
  HardDrive,
  Calendar,
  FileType,
  Copy,
  AlertTriangle,
  Crown,
} from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";

interface UploadedFile {
  id: string;
  name: string;
  url: string;
  type: "image" | "video" | "gif";
  size: number;
  format?: string;
  width?: number;
  height?: number;
  duration?: number;
  uploadedAt: Date;
}

interface MediaUploadDialogProps {
  open: boolean;
  onClose: () => void;
  currentFolder: string;
  onUploadComplete: () => void;
}

export function MediaUploadDialog({
  open,
  onClose,
  currentFolder,
  onUploadComplete,
}: MediaUploadDialogProps) {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState<Record<string, number>>({});
  const [uploadedFiles, setUploadedFiles] = useState<UploadedFile[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [quotaError, setQuotaError] = useState<string | null>(null);
  const [showUpgradeModal, setShowUpgradeModal] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { canUploadMedia, incrementMediaUpload, quota, planLimits } = useQuotas();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  // Check quota when files are added
  useEffect(() => {
    const checkQuota = async () => {
      if (files.length === 0) {
        setQuotaError(null);
        return;
      }
      const result = await canUploadMedia();
      if (!result.allowed) {
        setQuotaError(result.message || t("upload.uploadLimitReached", "Upload limit reached"));
      } else {
        setQuotaError(null);
      }
    };
    checkQuota();
  }, [files.length, t]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setFiles((prev) => [...prev, ...acceptedFiles]);
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      "image/*": [".jpeg", ".jpg", ".png", ".gif", ".webp"],
      "video/*": [".mp4", ".mov", ".avi", ".webm"],
    },
    maxSize: 100 * 1024 * 1024, // 100MB
  });

  const removeFile = (index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  };

  const formatFileSize = (bytes: number) => {
    if (bytes < 1024) return bytes + " B";
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + " KB";
    return (bytes / (1024 * 1024)).toFixed(1) + " MB";
  };

  const handleUpload = async () => {
    if (files.length === 0) return;

    // Check quota before uploading
    const quotaCheck = await canUploadMedia();
    if (!quotaCheck.allowed) {
      toast({
        title: t("toast.uploadLimit", "Upload limit reached"),
        description: quotaCheck.message,
        variant: "destructive",
      });
      return;
    }

    setUploading(true);
    const uploaded: UploadedFile[] = [];

    for (let i = 0; i < files.length; i++) {
      const file = files[i];
      const fileId = `file-${i}`;
      const startTime = Date.now();
      let operationId: string | null = null;

      // Check quota for each file (in case we're uploading multiple)
      const canUpload = await incrementMediaUpload();
      if (!canUpload) {
        toast({
          title: t("toast.uploadLimit", "Upload limit reached"),
          description: t("toast.uploadLimitFile", "Could not upload {{name}}. Daily upload limit reached.", { name: file.name }),
          variant: "destructive",
        });
        setUploadProgress((prev) => ({ ...prev, [fileId]: -1 }));
        continue;
      }
      
      try {
        setUploadProgress((prev) => ({ ...prev, [fileId]: 10 }));
        
        // Log the upload operation
        const isGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
        const fileType = file.type.startsWith("video") ? "video" : isGif ? "gif" : "image";
        
        operationId = await logOperation({
          operationType: "upload",
          fileName: file.name,
          operationDetails: {
            fileType,
            fileSize: file.size,
            folder: currentFolder,
          },
        });

        // Convert file to base64
        const reader = new FileReader();
        const base64 = await new Promise<string>((resolve, reject) => {
          reader.onload = () => resolve(reader.result as string);
          reader.onerror = reject;
          reader.readAsDataURL(file);
        });

        setUploadProgress((prev) => ({ ...prev, [fileId]: 30 }));

        // Upload to Cloudinary via edge function
        const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
          body: {
            fileData: base64,
            fileName: file.name,
            fileType,
          },
        });

        setUploadProgress((prev) => ({ ...prev, [fileId]: 90 }));

        if (error) throw error;

        if (data?.success && data?.mediaFileId) {
          // Update the folder_path in the media_files table
          if (currentFolder !== "/") {
            await supabase
              .from("media_files")
              .update({ folder_path: currentFolder })
              .eq("id", data.mediaFileId);
          }

          // Determine display type
          const isGifFile = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
          const displayType: "image" | "video" | "gif" = file.type.startsWith("video") 
            ? "video" 
            : isGifFile 
              ? "gif" 
              : "image";

          uploaded.push({
            id: data.mediaFileId,
            name: file.name,
            url: data.url,
            type: displayType,
            size: data.bytes || file.size,
            format: data.format,
            width: data.width,
            height: data.height,
            duration: data.duration,
            uploadedAt: new Date(),
          });

          setUploadProgress((prev) => ({ ...prev, [fileId]: 100 }));
          
          // Mark operation as complete
          if (operationId) {
            await completeOperation(operationId, data.url, Date.now() - startTime);
          }
        } else {
          throw new Error(data?.error || "Upload failed");
        }
      } catch (error) {
        console.error("Upload error:", error);
        toast({
          title: t("toast.uploadFailed", "Upload failed"),
          description: t("toast.uploadFailedFile", "Failed to upload {{name}}", { name: file.name }),
          variant: "destructive",
        });
        setUploadProgress((prev) => ({ ...prev, [fileId]: -1 }));
        
        // Mark operation as failed
        if (operationId) {
          await failOperation(
            operationId,
            error instanceof Error ? error.message : "Upload failed",
            Date.now() - startTime
          );
        }
      }
    }

    setUploadedFiles(uploaded);
    setShowResults(true);
    setUploading(false);
    
    if (uploaded.length > 0) {
      toast({
        title: t("toast.uploadComplete", "Upload complete"),
        description: t("toast.uploadCompleteDesc", "Successfully uploaded {{count}} file(s)", { count: uploaded.length }),
      });
      onUploadComplete();
    }
  };

  const handleDownload = async (file: UploadedFile) => {
    try {
      const response = await fetch(file.url);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = file.name;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (error) {
      toast({
        title: t("toast.downloadFailed", "Download failed"),
        description: t("errors.couldNotDownload", "Could not download the file"),
        variant: "destructive",
      });
    }
  };

  const copyUrl = (url: string) => {
    navigator.clipboard.writeText(url);
    toast({
      title: t("toast.urlCopied", "URL copied"),
      description: t("toast.urlCopiedDesc", "The file URL has been copied to your clipboard"),
    });
  };

  const handleClose = () => {
    setFiles([]);
    setUploadProgress({});
    setUploadedFiles([]);
    setShowResults(false);
    setQuotaError(null);
    onClose();
  };

  // Calculate remaining uploads. planLimits is the already-resolved value
  // from useQuotas() (override -> plan -> free literal, same as the SQL
  // arbiter) — the raw quota row's max_media_uploads_per_day is normally
  // NULL (inherit), so falling back to a hardcoded 20 here ignored both
  // per-user overrides and any plan edit (I2, 2026-08-23 final review).
  const maxUploads = planLimits.max_media_uploads_per_day;
  const usedUploads = quota?.media_uploads_today ?? 0;
  const remainingUploads = maxUploads === -1 ? t("upload.unlimited", "Unlimited") : Math.max(0, maxUploads - usedUploads);

  const resetUpload = () => {
    setFiles([]);
    setUploadProgress({});
    setUploadedFiles([]);
    setShowResults(false);
    setQuotaError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload className="w-5 h-5" />
            {showResults ? t("upload.complete", "Upload Complete") : t("upload.title", "Upload Media")}
          </DialogTitle>
        </DialogHeader>

        {showResults ? (
          <div className="flex-1 overflow-auto space-y-4">
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted-foreground">
                {t("upload.successCount", "{{count}} file(s) uploaded successfully", { count: uploadedFiles.length })}
              </p>
              <Button variant="outline" size="sm" onClick={resetUpload}>
                {t("actions.uploadMore", "Upload More")}
              </Button>
            </div>

            <div className="space-y-3">
              {uploadedFiles.map((file) => (
                <div
                  key={file.id}
                  className="border border-border rounded-lg p-4 space-y-3"
                >
                  <div className="flex gap-4">
                    {/* Thumbnail */}
                    <div className="w-24 h-24 rounded-lg overflow-hidden bg-muted shrink-0">
                      {file.type === "image" ? (
                        <img
                          src={file.url}
                          alt={file.name}
                          className="w-full h-full object-cover"
                        />
                      ) : (
                        <video
                          src={file.url}
                          className="w-full h-full object-cover"
                        />
                      )}
                    </div>

                    {/* Details */}
                    <div className="flex-1 min-w-0">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <h4 className="font-medium truncate">{file.name}</h4>
                          <Badge variant="secondary" className="mt-1">
                            {file.type === "image" ? (
                              <FileImage className="w-3 h-3 mr-1" />
                            ) : (
                              <FileVideo className="w-3 h-3 mr-1" />
                            )}
                            {file.type === "video" ? t("type.videoLower", "video") : file.type === "gif" ? t("type.gif", "gif") : t("type.imageLower", "image")}
                          </Badge>
                        </div>
                        <Check className="w-5 h-5 text-emerald-500 shrink-0" />
                      </div>

                      <div className="grid grid-cols-2 gap-x-4 gap-y-1 mt-3 text-sm">
                        <div className="flex items-center gap-1.5 text-muted-foreground">
                          <HardDrive className="w-3.5 h-3.5" />
                          <span>{formatFileSize(file.size)}</span>
                        </div>
                        {file.format && (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <FileType className="w-3.5 h-3.5" />
                            <span>{file.format.toUpperCase()}</span>
                          </div>
                        )}
                        {file.width && file.height && (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <span>{file.width} × {file.height}</span>
                          </div>
                        )}
                        {file.duration && (
                          <div className="flex items-center gap-1.5 text-muted-foreground">
                            <span>{Math.round(file.duration)}s</span>
                          </div>
                        )}
                        <div className="flex items-center gap-1.5 text-muted-foreground col-span-2">
                          <Calendar className="w-3.5 h-3.5" />
                          <span>{format(file.uploadedAt, "MMM d, yyyy h:mm a")}</span>
                        </div>
                      </div>
                    </div>
                  </div>

                  {/* Actions */}
                  <div className="flex gap-2 pt-2 border-t border-border">
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => handleDownload(file)}
                    >
                      <Download className="w-4 h-4 mr-2" />
                      {t("common:download", "Download")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      className="flex-1"
                      onClick={() => copyUrl(file.url)}
                    >
                      <Copy className="w-4 h-4 mr-2" />
                      {t("upload.copyUrl", "Copy URL")}
                    </Button>
                    <Button
                      variant="outline"
                      size="sm"
                      asChild
                    >
                      <a href={file.url} target="_blank" rel="noopener noreferrer">
                        <ExternalLink className="w-4 h-4" />
                      </a>
                    </Button>
                  </div>
                </div>
              ))}
            </div>

            <div className="flex justify-end pt-4">
              <Button onClick={handleClose}>{t("common:done", "Done")}</Button>
            </div>
          </div>
        ) : (
          <div className="flex-1 overflow-auto space-y-4">
            {/* Dropzone */}
            <div
              {...getRootProps()}
              className={cn(
                "border-2 border-dashed rounded-lg p-8 text-center cursor-pointer transition-colors",
                isDragActive
                  ? "border-primary bg-primary/5"
                  : "border-border hover:border-primary/50"
              )}
            >
              <input {...getInputProps()} />
              <Upload className="w-10 h-10 mx-auto text-muted-foreground mb-3" />
              {isDragActive ? (
                <p className="text-primary font-medium">{t("upload.dropHere", "Drop files here...")}</p>
              ) : (
                <>
                  <p className="font-medium">{t("upload.dropOrClick", "Drop files here or click to browse")}</p>
                  <p className="text-sm text-muted-foreground mt-1">
                    {t("upload.sizeHint", "Supports images and videos up to 100MB")}
                  </p>
                </>
              )}
            </div>

            {/* Current folder & quota info */}
            <div className="flex items-center justify-between text-sm text-muted-foreground">
              {currentFolder !== "/" && (
                <span>
                  {t("upload.uploadingTo", "Uploading to: {{folder}}", { folder: currentFolder })}
                </span>
              )}
              <span className="ml-auto">
                <Trans
                  ns="assets"
                  i18nKey="upload.remaining"
                  defaults="Uploads remaining today: <value>{{remaining}}</value>"
                  values={{ remaining: remainingUploads }}
                  components={{ value: <span className="font-medium" /> }}
                >
                  Uploads remaining today: <span className="font-medium">{remainingUploads}</span>
                </Trans>
              </span>
            </div>

            {/* Quota warning */}
            {quotaError && (
              <Alert variant="destructive" className="cursor-pointer" onClick={() => setShowUpgradeModal(true)}>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription className="flex items-center justify-between">
                  <span>{quotaError}</span>
                  <Button variant="ghost" size="sm" className="gap-1 h-auto py-1 px-2">
                    <Crown className="w-3 h-3" />
                    {t("upload.upgrade", "Upgrade")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}

            {/* File list */}
            {files.length > 0 && (
              <div className="space-y-2">
                <h4 className="text-sm font-medium">{t("upload.filesToUpload", "Files to upload ({{count}})", { count: files.length })}</h4>
                <div className="space-y-2 max-h-[200px] overflow-auto">
                  {files.map((file, index) => {
                    const fileId = `file-${index}`;
                    const progress = uploadProgress[fileId];
                    const isUploading = progress !== undefined && progress >= 0 && progress < 100;
                    const isComplete = progress === 100;
                    const isFailed = progress === -1;

                    return (
                      <div
                        key={index}
                        className="flex items-center gap-3 p-3 bg-muted/50 rounded-lg"
                      >
                        <div className="shrink-0">
                          {file.type.startsWith("image") ? (
                            <FileImage className="w-5 h-5 text-muted-foreground" />
                          ) : (
                            <FileVideo className="w-5 h-5 text-muted-foreground" />
                          )}
                        </div>
                        <div className="flex-1 min-w-0">
                          <p className="text-sm font-medium truncate">{file.name}</p>
                          <div className="flex items-center gap-2 text-xs text-muted-foreground">
                            <span>{formatFileSize(file.size)}</span>
                            {isComplete && (
                              <Badge variant="secondary" className="text-emerald-600 bg-emerald-400/10">
                                <Check className="w-3 h-3 mr-1" />
                                {t("upload.uploaded", "Uploaded")}
                              </Badge>
                            )}
                            {isFailed && (
                              <Badge variant="destructive">{t("common:status.failed", "Failed")}</Badge>
                            )}
                          </div>
                          {isUploading && (
                            <Progress value={progress} className="h-1 mt-2" />
                          )}
                        </div>
                        {!uploading && (
                          <Button
                            variant="ghost"
                            size="icon"
                            className="h-8 w-8 shrink-0"
                            onClick={() => removeFile(index)}
                          >
                            <X className="w-4 h-4" />
                          </Button>
                        )}
                        {isUploading && (
                          <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-4">
              <Button variant="outline" onClick={handleClose} disabled={uploading}>
                {t("common:cancel", "Cancel")}
              </Button>
              <Button
                onClick={handleUpload}
                disabled={files.length === 0 || uploading || !!quotaError}
              >
                {uploading ? (
                  <>
                    <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                    {t("dialog.uploading", "Uploading...")}
                  </>
                ) : files.length > 0 ? (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {t("upload.uploadCount", "Upload ({{count}})", { count: files.length })}
                  </>
                ) : (
                  <>
                    <Upload className="w-4 h-4 mr-2" />
                    {t("common:upload", "Upload")}
                  </>
                )}
              </Button>
            </div>
          </div>
        )}

        {/* Upgrade Modal */}
        <UpgradePromptModal
          open={showUpgradeModal}
          onOpenChange={setShowUpgradeModal}
          limitType="media_upload"
          maxAllowed={maxUploads}
        />
      </DialogContent>
    </Dialog>
  );
}
