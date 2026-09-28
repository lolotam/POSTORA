import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useLogMediaOperation } from "@/hooks/useMediaOperationsHistory";
import { Loader2, Upload, RefreshCw, Image, Video } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";

interface ReplaceFileDialogProps {
  open: boolean;
  onClose: () => void;
  file: {
    id: string;
    publicUrl: string;
    file_type: string;
    file_path: string;
    cloudinary_public_id?: string;
    storage_bucket: string;
  } | null;
  userId: string;
  onReplaced: () => void;
}

export function ReplaceFileDialog({
  open,
  onClose,
  file,
  userId,
  onReplaced,
}: ReplaceFileDialogProps) {
  const [newFile, setNewFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [replacing, setReplacing] = useState(false);
  const [progress, setProgress] = useState(0);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();
  const fileTypeLabel = file?.file_type === "video"
    ? t("type.videoLower", "video")
    : t("type.imageLower", "image");

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) {
      const droppedFile = acceptedFiles[0];
      setNewFile(droppedFile);

      // Create preview
      const url = URL.createObjectURL(droppedFile);
      setPreview(url);
    }
  }, []);

  const acceptedTypes = file?.file_type === "image"
    ? { "image/*": [".jpg", ".jpeg", ".png", ".gif", ".webp"] }
    : { "video/*": [".mp4", ".mov", ".avi", ".webm"] };

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: acceptedTypes,
    maxFiles: 1,
    multiple: false,
  });

  const handleReplace = async () => {
    if (!newFile || !file) return;

    setReplacing(true);
    setProgress(10);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "replace_file",
        mediaFileId: file.id,
        fileName: newFile.name,
        operationDetails: {
          fileType: file.file_type,
          newFileSize: newFile.size,
          newFileName: newFile.name,
        },
      });

      // Delete the old file first
      if (file.storage_bucket === "cloudinary" && file.cloudinary_public_id) {
        await supabase.functions.invoke("cloudinary-delete", {
          body: {
            publicIds: [file.cloudinary_public_id],
            resourceType: file.file_type,
          },
        });
      } else {
        await supabase.storage.from("media").remove([file.file_path]);
      }

      setProgress(30);

      // Upload to Cloudinary
      const formData = new FormData();
      formData.append("file", newFile);
      formData.append("resourceType", file.file_type);

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
        "cloudinary-upload",
        { body: formData }
      );

      if (uploadError) throw uploadError;

      setProgress(70);

      // Update the database record with new file info
      const { error: updateError } = await supabase
        .from("media_files")
        .update({
          file_path: uploadData.secure_url,
          cloudinary_public_id: uploadData.public_id,
          file_size: newFile.size,
          mime_type: newFile.type,
          storage_bucket: "cloudinary",
        })
        .eq("id", file.id);

      if (updateError) throw updateError;

      setProgress(100);

      toast({
        title: t("toast.fileReplaced", "File replaced"),
        description: t("toast.fileReplacedDesc", "The file has been replaced successfully"),
      });

      if (operationId) {
        await completeOperation(operationId, uploadData.secure_url, Date.now() - startTime);
      }

      onReplaced();
      handleClose();
    } catch (error) {
      console.error("Replace error:", error);
      toast({
        title: t("toast.replaceFailed", "Replace failed"),
        description: t("errors.replaceFailed", "Could not replace the file"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Replace failed",
          Date.now() - startTime
        );
      }
    } finally {
      setReplacing(false);
      setProgress(0);
    }
  };

  const handleClose = () => {
    setNewFile(null);
    if (preview) {
      URL.revokeObjectURL(preview);
      setPreview(null);
    }
    onClose();
  };

  if (!file) return null;

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <RefreshCw className="w-5 h-5" />
            {t("replace.title", "Replace File")}
          </DialogTitle>
          <DialogDescription>
            {t("replace.desc", "Upload a new {{fileType}} to replace the current one. The file name and all references will be preserved.", { fileType: fileTypeLabel })}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current file preview */}
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("replace.currentFile", "Current File")}</p>
            <div className="border rounded-lg p-2 bg-muted/50">
              {file.file_type === "image" ? (
                <img
                  src={file.publicUrl}
                  alt=""
                  className="max-h-32 rounded object-contain mx-auto"
                />
              ) : (
                <video
                  src={file.publicUrl}
                  className="max-h-32 rounded mx-auto"
                />
              )}
            </div>
          </div>

          {/* Drop zone for new file */}
          <div
            {...getRootProps()}
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
              isDragActive
                ? "border-primary bg-primary/5"
                : "border-border hover:border-primary/50"
            )}
          >
            <input {...getInputProps()} />
            {preview ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-green-600">{t("replace.newSelected", "New file selected")}</p>
                {newFile?.type.startsWith("image/") ? (
                  <img
                    src={preview}
                    alt=""
                    className="max-h-32 rounded object-contain mx-auto"
                  />
                ) : (
                  <video src={preview} className="max-h-32 rounded mx-auto" />
                )}
                <p className="text-xs text-muted-foreground">{newFile?.name}</p>
              </div>
            ) : (
              <div className="space-y-2">
                {file.file_type === "image" ? (
                  <Image className="w-10 h-10 mx-auto text-muted-foreground" />
                ) : (
                  <Video className="w-10 h-10 mx-auto text-muted-foreground" />
                )}
                <div>
                  <p className="font-medium">
                    {isDragActive
                      ? t("replace.dropHere", "Drop your {{fileType}} here", { fileType: fileTypeLabel })
                      : t("replace.dragOrClick", "Drag & drop or click to select")}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    {t("replace.selectNew", "Select a new {{fileType}} file", { fileType: fileTypeLabel })}
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Progress bar */}
          {replacing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>{t("replace.progress", "Replacing file...")}</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={replacing}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleReplace} disabled={!newFile || replacing}>
            {replacing ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("replace.replacing", "Replacing...")}
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 me-2" />
                {t("actions.replace", "Replace")}
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
