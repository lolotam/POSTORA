import { useState, useCallback } from "react";
import { useTranslation } from "react-i18next";
import type { FileRejection } from "react-dropzone";
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
import { readUploadRefusal } from "@/components/media/uploadErrors";
import { FileTypeTile } from "@/components/media/FileTypeTile";
import { Loader2, Upload, RefreshCw } from "lucide-react";
import { useDropzone } from "react-dropzone";
import { cn } from "@/lib/utils";
import { Progress } from "@/components/ui/progress";
import { readFileAsDataUrl } from "@/lib/readFileAsDataUrl";
import {
  dropzoneAcceptForKind,
  libraryFilePresentation,
  MEDIA_DECODED_BYTE_CAP,
  mediaTypeForFileName,
  uploadFileTypeFor,
  type LibraryFileLike,
  type MediaKind,
} from "@/lib/mediaTypes";

interface ReplaceFileDialogProps {
  open: boolean;
  onClose: () => void;
  file: ({
    id: string;
    publicUrl: string;
    file_type: string;
    file_path: string;
  } & LibraryFileLike) | null;
  userId: string;
  onReplaced: () => void;
}

const KIND_LABEL: Record<MediaKind, [string, string]> = {
  image: ["type.image", "image"],
  video: ["type.video", "video"],
  audio: ["type.audio", "audio"],
  document: ["type.document", "document"],
  archive: ["type.archive", "archive"],
};

function KindPreview({ kind, src, file }: { kind: MediaKind; src: string; file: LibraryFileLike }) {
  if (kind === "image") {
    return <img src={src} alt="" className="max-h-32 rounded object-contain mx-auto" />;
  }
  if (kind === "video") {
    return <video src={src} className="max-h-32 rounded mx-auto" />;
  }
  return (
    <div className="mx-auto h-32 w-32 overflow-hidden rounded">
      <FileTypeTile {...libraryFilePresentation(file)} />
    </div>
  );
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
  const presentation = file ? libraryFilePresentation(file) : null;
  const kind = presentation?.kind ?? "image";
  const [labelKey, labelFallback] = KIND_LABEL[kind];
  const fileTypeLabel = t(labelKey, labelFallback);

  const clearPreview = useCallback(() => {
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return null;
    });
    setNewFile(null);
  }, []);

  const showReject = useCallback((description: string) => {
    clearPreview();
    toast({
      title: t("toast.replaceFailed", "Replace failed"),
      description,
      variant: "destructive",
    });
  }, [clearPreview, t, toast]);

  const acceptFile = useCallback((droppedFile: File) => {
    if (!file) return;
    const incoming = mediaTypeForFileName(droppedFile.name);
    if (!incoming || incoming.kind !== libraryFilePresentation(file).kind) {
      showReject(t("replace.wrongKind", "The new file must be the same kind as the old one"));
      return;
    }
    if (droppedFile.size > MEDIA_DECODED_BYTE_CAP) {
      showReject(t("replace.tooLarge", "This file is over the 10 MB limit"));
      return;
    }
    setNewFile(droppedFile);
    setPreview((current) => {
      if (current) URL.revokeObjectURL(current);
      return URL.createObjectURL(droppedFile);
    });
  }, [file, showReject, t]);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    if (acceptedFiles.length > 0) acceptFile(acceptedFiles[0]);
  }, [acceptFile]);

  const onDropRejected = useCallback((rejections: FileRejection[]) => {
    const invalidType = rejections.some((rejection) => rejection.errors.some((error) => error.code === "file-invalid-type"));
    showReject(invalidType
      ? t("replace.wrongKind", "The new file must be the same kind as the old one")
      : t("replace.tooLarge", "This file is over the 10 MB limit"));
  }, [showReject, t]);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    onDropRejected,
    accept: dropzoneAcceptForKind(kind),
    maxSize: MEDIA_DECODED_BYTE_CAP,
    maxFiles: 1,
    multiple: false,
  });

  const handleReplace = async () => {
    if (!newFile || !file) return;
    const incoming = mediaTypeForFileName(newFile.name);
    if (!incoming || incoming.kind !== libraryFilePresentation(file).kind) {
      showReject(t("replace.wrongKind", "The new file must be the same kind as the old one"));
      return;
    }
    if (newFile.size > MEDIA_DECODED_BYTE_CAP) {
      showReject(t("replace.tooLarge", "This file is over the 10 MB limit"));
      return;
    }

    setReplacing(true);
    setProgress(10);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      operationId = await logOperation({
        operationType: "replace_file",
        mediaFileId: file.id,
        fileName: newFile.name,
        operationDetails: {
          fileType: file.file_type,
          newFileSize: newFile.size,
          newFileName: newFile.name,
          userId,
        },
      });

      const fileData = await readFileAsDataUrl(newFile);
      setProgress(40);

      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: {
          fileData,
          fileName: newFile.name,
          fileType: uploadFileTypeFor(incoming.kind),
          replaceMediaFileId: file.id,
        },
      });
      if (error || !data?.success) {
        const fromError = error ? await readUploadRefusal(error) : null;
        const fromBody = typeof data?.error === "string" ? data.error : null;
        throw new Error(fromBody || fromError || t("errors.replaceFailed", "Could not replace the file"));
      }

      setProgress(100);
      toast({
        title: t("toast.fileReplaced", "File replaced"),
        description: t("toast.fileReplacedDesc", "The file has been replaced successfully"),
      });
      if (operationId) await completeOperation(operationId, data.url, Date.now() - startTime);
      onReplaced();
      handleClose();
    } catch (error) {
      console.error("Replace error:", error);
      const description = error instanceof Error && error.message
        ? error.message
        : t("errors.replaceFailed", "Could not replace the file");
      toast({ title: t("toast.replaceFailed", "Replace failed"), description, variant: "destructive" });
      if (operationId) await failOperation(operationId, description, Date.now() - startTime);
    } finally {
      setReplacing(false);
      setProgress(0);
    }
  };

  const handleClose = () => {
    clearPreview();
    onClose();
  };

  if (!file || !presentation) return null;
  const selectedKind = newFile ? mediaTypeForFileName(newFile.name)?.kind : null;
  const selectedLike: LibraryFileLike | null = newFile && selectedKind
    ? { file_type: uploadFileTypeFor(selectedKind), file_path: newFile.name, mime_type: newFile.type, metadata: { original_filename: newFile.name } }
    : null;

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
          <div className="space-y-2">
            <p className="text-sm font-medium">{t("replace.currentFile", "Current File")}</p>
            <div className="border rounded-lg p-2 bg-muted/50">
              <KindPreview kind={kind} src={file.publicUrl} file={file} />
            </div>
          </div>

          <div
            {...getRootProps()}
            className={cn(
              "border-2 border-dashed rounded-lg p-6 text-center cursor-pointer transition-colors",
              isDragActive ? "border-primary bg-primary/5" : "border-border hover:border-primary/50",
            )}
          >
            <input {...getInputProps()} />
            {preview && newFile && selectedLike && selectedKind ? (
              <div className="space-y-2">
                <p className="text-sm font-medium text-green-600">{t("replace.newSelected", "New file selected")}</p>
                <KindPreview kind={selectedKind} src={preview} file={selectedLike} />
                <p className="text-xs text-muted-foreground">{newFile.name}</p>
              </div>
            ) : (
              <div className="space-y-2">
                <div className="mx-auto h-16 w-16 overflow-hidden rounded">
                  <FileTypeTile {...presentation} />
                </div>
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
