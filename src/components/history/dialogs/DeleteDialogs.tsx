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
import { Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";

interface DeletePostDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
}

export function DeletePostDialog({
  open,
  onClose,
  onConfirm,
  isDeleting,
}: DeletePostDialogProps) {
  const { t } = useTranslation("history");

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dialogs.deletePostTitle", "Delete Post")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("dialogs.deletePostDesc", "Are you sure you want to delete this post? This action cannot be undone.")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t("common:cancel", "Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
            {t("common:delete", "Delete")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

interface BulkDeleteDialogProps {
  open: boolean;
  onClose: () => void;
  onConfirm: () => void;
  isDeleting: boolean;
  count: number;
}

export function BulkDeleteDialog({
  open,
  onClose,
  onConfirm,
  isDeleting,
  count,
}: BulkDeleteDialogProps) {
  const { t } = useTranslation("history");

  return (
    <AlertDialog open={open} onOpenChange={(o) => !o && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("dialogs.bulkDeleteTitle", "Delete {{count}} Posts", { count })}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("dialogs.bulkDeleteDesc", "Are you sure you want to delete {{count}} selected posts? This action cannot be undone.", { count })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isDeleting}>{t("common:cancel", "Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            onClick={onConfirm}
            disabled={isDeleting}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isDeleting ? <Loader2 className="w-4 h-4 animate-spin me-2" /> : null}
            {t("dialogs.deleteAll", "Delete All")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
