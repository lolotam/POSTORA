import { useState, useEffect } from "react";
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
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useLogMediaOperation } from "@/hooks/useMediaOperationsHistory";
import { Loader2, Pencil } from "lucide-react";

interface RenameFileDialogProps {
  open: boolean;
  onClose: () => void;
  fileId: string;
  currentName: string;
  storageBucket: string;
  onRenamed: () => void;
}

// Helper to extract display name from file path or URL
const getDisplayName = (filePath: string, storageBucket: string): string => {
  if (storageBucket === "cloudinary") {
    // For Cloudinary URLs, extract the filename from the end
    // URL format: https://res.cloudinary.com/cloud/image/upload/v123/folder/filename.ext
    const parts = filePath.split("/");
    const lastPart = parts[parts.length - 1];
    // Remove any query params
    return lastPart.split("?")[0];
  }
  // For other storage, just get the last part of the path
  return filePath.split("/").pop() || filePath;
};

// Helper to get file extension
const getExtension = (filename: string): string => {
  const parts = filename.split(".");
  return parts.length > 1 ? parts.pop() || "" : "";
};

// Helper to get base name without extension
const getBaseName = (filename: string): string => {
  const ext = getExtension(filename);
  if (!ext) return filename;
  return filename.slice(0, -(ext.length + 1));
};

export function RenameFileDialog({
  open,
  onClose,
  fileId,
  currentName,
  storageBucket,
  onRenamed,
}: RenameFileDialogProps) {
  const [newName, setNewName] = useState("");
  const [renaming, setRenaming] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  // Calculate display name and extension when dialog opens
  const displayName = getDisplayName(currentName, storageBucket);
  const extension = getExtension(displayName);
  // Only files in the Supabase "media" bucket are addressed by a relative path that a rename can
  // move. Openinary and Cloudinary rows store the delivery URL in file_path, so renaming them must
  // change only the name the Library shows and downloads with (Cloudinary itself is disabled).
  const renamesStoragePath = storageBucket === "media";

  useEffect(() => {
    if (open) {
      const display = getDisplayName(currentName, storageBucket);
      setNewName(getBaseName(display));
    }
  }, [open, currentName, storageBucket]);

  const handleRename = async () => {
    if (!newName.trim()) return;

    setRenaming(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      const finalName = extension ? `${newName.trim()}.${extension}` : newName.trim();

      // Log the operation
      operationId = await logOperation({
        operationType: "rename_file",
        fileName: displayName,
        operationDetails: {
          oldName: displayName,
          newName: finalName,
          renamesStoragePath,
        },
      });

      if (!renamesStoragePath) {
        const { data: row, error: fetchError } = await supabase
          .from("media_files")
          .select("metadata")
          .eq("id", fileId)
          .single();
        if (fetchError) throw fetchError;
        const metadata = row?.metadata && typeof row.metadata === "object" && !Array.isArray(row.metadata)
          ? row.metadata as Record<string, unknown>
          : {};
        const { error } = await supabase
          .from("media_files")
          .update({ metadata: { ...metadata, original_filename: finalName } })
          .eq("id", fileId);
        if (error) throw error;

        toast({
          title: t("toast.fileRenamed", "File renamed"),
          description: t("toast.fileRenamedDesc", "Renamed to \"{{name}}\"", { name: finalName }),
        });
      } else {
        // For Supabase storage, update the file_path
        const { data: file, error: fetchError } = await supabase
          .from("media_files")
          .select("folder_path")
          .eq("id", fileId)
          .single();

        if (fetchError) throw fetchError;

        const folderPath = file.folder_path || "/";
        const newFilePath =
          folderPath === "/"
            ? finalName
            : `${folderPath.replace(/^\//, "")}/${finalName}`;

        const { error } = await supabase
          .from("media_files")
          .update({ file_path: newFilePath })
          .eq("id", fileId);

        if (error) throw error;

        toast({
          title: t("toast.fileRenamed", "File renamed"),
          description: t("toast.fileRenamedDesc", "Renamed to \"{{name}}\"", { name: finalName }),
        });
      }

      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }

      onRenamed();
      onClose();
    } catch (error) {
      console.error("Rename error:", error);
      toast({
        title: t("toast.renameFailed", "Rename failed"),
        description: error instanceof Error ? error.message : t("errors.renameFailed", "Could not rename the file"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Rename failed",
          Date.now() - startTime
        );
      }
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-5 h-5" />
            {t("rename.fileTitle", "Rename File")}
          </DialogTitle>
          <DialogDescription>
            {t("rename.fileSubtitle", "Enter a new name for this file.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="file-name">{t("rename.newName", "New Name")}</Label>
            <div className="flex items-center gap-2">
              <Input
                id="file-name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder={t("rename.namePlaceholder", "Enter new name")}
                onKeyDown={(e) => e.key === "Enter" && handleRename()}
              />
              {extension && (
                <span className="text-sm text-muted-foreground shrink-0">
                  .{extension}
                </span>
              )}
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={renaming}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleRename} disabled={!newName.trim() || renaming}>
            {renaming ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("rename.renaming", "Renaming...")}
              </>
            ) : (
              t("common:rename", "Rename")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface RenameFolderDialogProps {
  open: boolean;
  onClose: () => void;
  folderId: string;
  currentName: string;
  currentPath: string;
  parentPath: string;
  onRenamed: () => void;
}

export function RenameFolderDialog({
  open,
  onClose,
  folderId,
  currentName,
  currentPath,
  parentPath,
  onRenamed,
}: RenameFolderDialogProps) {
  const [newName, setNewName] = useState(currentName);
  const [renaming, setRenaming] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  useEffect(() => {
    if (open) {
      setNewName(currentName);
    }
  }, [open, currentName]);

  const handleRename = async () => {
    if (!newName.trim()) return;

    setRenaming(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Sanitize folder name
      const sanitizedName = newName.trim().replace(/[\/\\]/g, "-");
      const newFullPath =
        parentPath === "/" ? `/${sanitizedName}` : `${parentPath}/${sanitizedName}`;

      // Log the operation
      operationId = await logOperation({
        operationType: "rename_folder",
        fileName: currentName,
        operationDetails: {
          oldName: currentName,
          newName: sanitizedName,
          oldPath: currentPath,
          newPath: newFullPath,
        },
      });

      // Update the folder
      const { error } = await supabase
        .from("media_folders")
        .update({
          name: sanitizedName,
          full_path: newFullPath,
        })
        .eq("id", folderId);

      if (error) {
        if (error.code === "23505") {
          toast({
            title: t("toast.folderExists", "Folder exists"),
            description: t("toast.folderExistsDesc", "A folder with this name already exists"),
            variant: "destructive",
          });
          if (operationId) {
            await failOperation(operationId, "Folder already exists", Date.now() - startTime);
          }
          return;
        }
        throw error;
      }

      // Update all files in this folder to the new path
      await supabase
        .from("media_files")
        .update({ folder_path: newFullPath })
        .eq("folder_path", currentPath);

      // Update all subfolders
      const { data: subfolders } = await supabase
        .from("media_folders")
        .select("*")
        .like("full_path", `${currentPath}/%`);

      if (subfolders && subfolders.length > 0) {
        for (const subfolder of subfolders) {
          const newSubfolderPath = subfolder.full_path.replace(
            currentPath,
            newFullPath
          );
          const newParentPath = subfolder.parent_path.replace(
            currentPath,
            newFullPath
          );

          await supabase
            .from("media_folders")
            .update({
              full_path: newSubfolderPath,
              parent_path: newParentPath,
            })
            .eq("id", subfolder.id);
        }
      }

      toast({
        title: t("toast.folderRenamed", "Folder renamed"),
        description: t("toast.folderRenamedDesc", "Renamed to \"{{name}}\"", { name: sanitizedName }),
      });

      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }

      onRenamed();
      onClose();
    } catch (error) {
      console.error("Rename folder error:", error);
      toast({
        title: t("toast.renameFailed", "Rename failed"),
        description: t("errors.renameFolderFailed", "Could not rename the folder"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Rename failed",
          Date.now() - startTime
        );
      }
    } finally {
      setRenaming(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Pencil className="w-5 h-5" />
            {t("rename.folderTitle", "Rename Folder")}
          </DialogTitle>
          <DialogDescription>
            {t("rename.folderSubtitle", "Enter a new name for this folder.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name">{t("rename.newName", "New Name")}</Label>
            <Input
              id="folder-name"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder={t("rename.namePlaceholder", "Enter new name")}
              onKeyDown={(e) => e.key === "Enter" && handleRename()}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={renaming}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleRename} disabled={!newName.trim() || renaming}>
            {renaming ? (
              <>
                <Loader2 className="w-4 h-4 me-2 animate-spin" />
                {t("rename.renaming", "Renaming...")}
              </>
            ) : (
              t("common:rename", "Rename")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// Helper function to get display name for files (exported for use in MediaLibrary)
export const getFileDisplayName = (file: {
  file_path: string;
  storage_bucket: string;
  cloudinary_public_id?: string | null;
  metadata?: { original_filename?: unknown } | null;
}): string => {
  const original = file.metadata?.original_filename;
  if (typeof original === "string" && original.trim()) return original.trim();
  // For Cloudinary files, extract from public_id (cleaner than URL)
  if (file.storage_bucket === "cloudinary" && file.cloudinary_public_id) {
    const parts = file.cloudinary_public_id.split("/");
    return parts[parts.length - 1];
  }
  return getDisplayName(file.file_path, file.storage_bucket);
};
