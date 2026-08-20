import { useState, useCallback } from "react";
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
    file_type: "image" | "video";
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
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

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

      // Upload the replacement through the unified uploader (Openinary-priority, JSON body)
      const reader = new FileReader();
      const base64 = await new Promise<string>((resolve, reject) => {
        reader.onload = () => resolve(reader.result as string);
        reader.onerror = reject;
        reader.readAsDataURL(newFile);
      });
      const isGif = newFile.type === "image/gif" || newFile.name.toLowerCase().endsWith(".gif");
      const uploadFileType = newFile.type.startsWith("video") ? "video" : isGif ? "gif" : "image";

      const { data: uploadData, error: uploadError } = await supabase.functions.invoke(
        "cloudinary-upload",
        {
          body: {
            fileData: base64,
            fileName: newFile.name,
            fileType: uploadFileType,
          },
        }
      );

      if (uploadError) throw uploadError;
      if (!uploadData?.success || !uploadData?.mediaFileId) {
        throw new Error(uploadData?.error || "Upload failed");
      }

      setProgress(70);

      // Point the original media_files row at the new upload: copy the new row's
      // provider-backed fields over, then delete the new redundant row so the
      // file keeps its original id (posts reference it by id).
      const { data: newFileRow, error: newFileFetchError } = await supabase
        .from("media_files")
        .select("file_path, cloudinary_public_id, storage_bucket, file_size, mime_type, metadata")
        .eq("id", uploadData.mediaFileId)
        .single();
      if (newFileFetchError) throw newFileFetchError;

      const { error: updateError } = await supabase
        .from("media_files")
        .update({
          file_path: newFileRow.file_path,
          cloudinary_public_id: newFileRow.cloudinary_public_id,
          file_size: newFileRow.file_size ?? newFile.size,
          mime_type: newFileRow.mime_type ?? newFile.type,
          storage_bucket: newFileRow.storage_bucket ?? "cloudinary",
          metadata: { ...(file.metadata as Record<string, unknown> | null), ...(newFileRow.metadata as Record<string, unknown> | null) },
          current_object_version: 1,
        })
        .eq("id", file.id);

      if (updateError) throw updateError;

      // Re-point the new upload's provider rows at the original media id, then
      // remove the shell row created for the replacement upload.
      await supabase.from("media_file_providers").delete().eq("media_file_id", file.id);
      await supabase.from("media_file_providers").update({ media_file_id: file.id }).eq("media_file_id", uploadData.mediaFileId);
      await supabase.from("media_files").delete().eq("id", uploadData.mediaFileId);

      setProgress(100);

      toast({
        title: "File replaced",
        description: "The file has been replaced successfully",
      });

      if (operationId) {
        await completeOperation(operationId, uploadData.url, Date.now() - startTime);
      }

      onReplaced();
      handleClose();
    } catch (error) {
      console.error("Replace error:", error);
      toast({
        title: "Replace failed",
        description: "Could not replace the file",
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
            Replace File
          </DialogTitle>
          <DialogDescription>
            Upload a new {file.file_type} to replace the current one. The file
            name and all references will be preserved.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Current file preview */}
          <div className="space-y-2">
            <p className="text-sm font-medium">Current File</p>
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
                <p className="text-sm font-medium text-green-600">New file selected</p>
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
                      ? `Drop your ${file.file_type} here`
                      : `Drag & drop or click to select`}
                  </p>
                  <p className="text-sm text-muted-foreground">
                    Select a new {file.file_type} file
                  </p>
                </div>
              </div>
            )}
          </div>

          {/* Progress bar */}
          {replacing && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span>Replacing file...</span>
                <span>{progress}%</span>
              </div>
              <Progress value={progress} />
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={replacing}>
            Cancel
          </Button>
          <Button onClick={handleReplace} disabled={!newFile || replacing}>
            {replacing ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                Replacing...
              </>
            ) : (
              <>
                <Upload className="w-4 h-4 mr-2" />
                Replace
              </>
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
