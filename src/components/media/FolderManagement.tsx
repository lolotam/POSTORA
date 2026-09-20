import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
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
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useLogMediaOperation } from "@/hooks/useMediaOperationsHistory";
import { FolderPlus, Loader2 } from "lucide-react";

interface CreateFolderDialogProps {
  open: boolean;
  onClose: () => void;
  parentPath: string;
  userId: string;
  onFolderCreated: () => void;
}

export function CreateFolderDialog({
  open,
  onClose,
  parentPath,
  userId,
  onFolderCreated,
}: CreateFolderDialogProps) {
  const [folderName, setFolderName] = useState("");
  const [creating, setCreating] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  const handleCreate = async () => {
    if (!folderName.trim()) return;

    setCreating(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Sanitize folder name
      const sanitizedName = folderName.trim().replace(/[\/\\]/g, "-");
      const fullPath = parentPath === "/" 
        ? `/${sanitizedName}`
        : `${parentPath}/${sanitizedName}`;
      
      // Log the operation
      operationId = await logOperation({
        operationType: "create_folder",
        fileName: sanitizedName,
        operationDetails: {
          folderName: sanitizedName,
          parentPath,
          fullPath,
        },
      });

      const { error } = await supabase
        .from("media_folders")
        .insert({
          user_id: userId,
          name: sanitizedName,
          parent_path: parentPath,
          full_path: fullPath,
        });

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
        } else {
          throw error;
        }
      } else {
        toast({
          title: t("toast.folderCreated", "Folder created"),
          description: t("toast.folderCreatedDesc", "Created folder \"{{name}}\"", { name: sanitizedName }),
        });
        if (operationId) {
          await completeOperation(operationId, undefined, Date.now() - startTime);
        }
        onFolderCreated();
        setFolderName("");
        onClose();
      }
    } catch (error) {
      console.error("Create folder error:", error);
      toast({
        title: t("common:error", "Error"),
        description: t("errors.createFolderFailed", "Failed to create folder"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Failed to create folder",
          Date.now() - startTime
        );
      }
    } finally {
      setCreating(false);
    }
  };

  const handleClose = () => {
    setFolderName("");
    onClose();
  };

  return (
    <Dialog open={open} onOpenChange={handleClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FolderPlus className="w-5 h-5" />
            {t("folders.createTitle", "Create New Folder")}
          </DialogTitle>
          <DialogDescription>
            {t("folders.subtitle", "Enter a name for your new folder.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="folder-name">{t("folders.folderName", "Folder Name")}</Label>
            <Input
              id="folder-name"
              value={folderName}
              onChange={(e) => setFolderName(e.target.value)}
              placeholder={t("folders.namePlaceholder", "Enter folder name")}
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
          </div>
          {parentPath !== "/" && (
            <p className="text-sm text-muted-foreground">
              {t("folders.createIn", "Creating in: {{path}}", { path: parentPath })}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={handleClose} disabled={creating}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleCreate} disabled={!folderName.trim() || creating}>
            {creating ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("folders.creating", "Creating...")}
              </>
            ) : (
              t("folders.createFolder", "Create Folder")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DeleteFolderDialogProps {
  open: boolean;
  onClose: () => void;
  folderName: string;
  folderId: string;
  onFolderDeleted: () => void;
}

export function DeleteFolderDialog({
  open,
  onClose,
  folderName,
  folderId,
  onFolderDeleted,
}: DeleteFolderDialogProps) {
  const [deleting, setDeleting] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  const handleDelete = async () => {
    setDeleting(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "delete_folder",
        fileName: folderName,
        operationDetails: {
          folderName,
          folderId,
        },
      });

      const { error } = await supabase
        .from("media_folders")
        .delete()
        .eq("id", folderId);

      if (error) throw error;

      toast({
        title: t("toast.folderDeleted", "Folder deleted"),
        description: t("toast.folderDeletedDesc", "Deleted folder \"{{name}}\"", { name: folderName }),
      });
      
      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }
      
      onFolderDeleted();
      onClose();
    } catch (error) {
      console.error("Delete folder error:", error);
      toast({
        title: t("common:error", "Error"),
        description: t("errors.deleteFolderFailed", "Failed to delete folder"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Failed to delete folder",
          Date.now() - startTime
        );
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog open={open} onOpenChange={onClose}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("folders.deleteTitle", "Delete folder \"{{name}}\"?", { name: folderName })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("folders.deleteBody", "This will delete the folder. Files inside will be moved to the root folder.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={deleting}>{t("common:cancel", "Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            onClick={handleDelete}
            disabled={deleting}
          >
            {deleting ? t("folders.deleting", "Deleting...") : t("common:delete", "Delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface MoveFileDialogProps {
  open: boolean;
  onClose: () => void;
  fileIds: string[];
  folders: Array<{ id: string; name: string; full_path: string }>;
  currentFolder: string;
  onFileMoved: () => void;
}

export function MoveFileDialog({
  open,
  onClose,
  fileIds,
  folders,
  currentFolder,
  onFileMoved,
}: MoveFileDialogProps) {
  const [selectedFolder, setSelectedFolder] = useState<string | null>(null);
  const [moving, setMoving] = useState(false);
  const { t } = useTranslation("assets");
  const { toast } = useToast();
  const { logOperation, completeOperation, failOperation } = useLogMediaOperation();

  // Reset selection when dialog opens
  const handleOpenChange = (isOpen: boolean) => {
    if (!isOpen) {
      setSelectedFolder(null);
      onClose();
    }
  };

  const handleMove = async () => {
    if (selectedFolder === null) return;
    
    setMoving(true);
    const startTime = Date.now();
    let operationId: string | null = null;

    try {
      // Log the operation
      operationId = await logOperation({
        operationType: "move_file",
        operationDetails: {
          filesCount: fileIds.length,
          destination: selectedFolder === "/" ? "Root" : selectedFolder,
          fromFolder: currentFolder,
        },
      });

      const { error } = await supabase
        .from("media_files")
        .update({ folder_path: selectedFolder })
        .in("id", fileIds);

      if (error) throw error;

      toast({
        title: t("toast.filesMoved", "Files moved"),
        description: t("toast.movedTo", "Moved {{count}} file(s) to {{destination}}", {
          count: fileIds.length,
          destination: selectedFolder === "/" ? t("library.root", "Root") : selectedFolder,
        }),
      });
      
      if (operationId) {
        await completeOperation(operationId, undefined, Date.now() - startTime);
      }
      
      onFileMoved();
      setSelectedFolder(null);
      onClose();
    } catch (error) {
      console.error("Move files error:", error);
      toast({
        title: t("common:error", "Error"),
        description: t("errors.moveFailed", "Failed to move files"),
        variant: "destructive",
      });
      if (operationId) {
        await failOperation(
          operationId,
          error instanceof Error ? error.message : "Failed to move files",
          Date.now() - startTime
        );
      }
    } finally {
      setMoving(false);
    }
  };

  // Filter out current folder from options
  const availableFolders = folders.filter((f) => f.full_path !== currentFolder);
  const showRootOption = currentFolder !== "/";

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("folders.moveTitle", "Move {{count}} file(s)", { count: fileIds.length })}</DialogTitle>
          <DialogDescription>
            {t("folders.moveSubtitle", "Select a destination folder for the selected files.")}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 max-h-[300px] overflow-auto">
          {showRootOption && (
            <Button
              variant={selectedFolder === "/" ? "secondary" : "ghost"}
              className="w-full justify-start"
              onClick={() => setSelectedFolder("/")}
            >
              {t("folders.rootOption", "📁 Root")}
            </Button>
          )}
          {availableFolders.length > 0 ? (
            availableFolders.map((folder) => (
              <Button
                key={folder.id}
                variant={selectedFolder === folder.full_path ? "secondary" : "ghost"}
                className="w-full justify-start"
                onClick={() => setSelectedFolder(folder.full_path)}
              >
                📁 {folder.name}
              </Button>
            ))
          ) : !showRootOption ? (
            <p className="text-sm text-muted-foreground text-center py-4">
              {t("folders.noFolders", "No folders available. Create a folder first to move files.")}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => handleOpenChange(false)} disabled={moving}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button onClick={handleMove} disabled={moving || selectedFolder === null}>
            {moving ? (
              <>
                <Loader2 className="w-4 h-4 mr-2 animate-spin" />
                {t("folders.moving", "Moving...")}
              </>
            ) : (
              t("folders.moveHere", "Move Here")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
