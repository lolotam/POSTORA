import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";

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

export type RemoveCompetitorDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The handle the owner is about to stop tracking. */
  username: string;
  /** The owner confirmed the removal. */
  onConfirm: () => void;
  /** The removal is in flight. */
  isPending?: boolean;
  /** The removal failed and the reason, already translated. */
  errorMessage?: string | null;
  /** The outcome of the removal could not be observed. */
  indeterminate?: boolean;
};

/**
 * The confirmation of a removal.
 *
 * A removal is a decision, not a click: it stops the collection, frees
 * a slot and starts a ninety day retention clock. The dialog names the
 * handle and says all three, so the owner is not guessing what the
 * button will do (spec §3, T8-L1).
 *
 * The dialog is focus trapped and Cancel is the first control, so the
 * default action of the keyboard is the safe one.
 */
export function RemoveCompetitorDialog({
  open,
  onOpenChange,
  username,
  onConfirm,
  isPending = false,
  errorMessage = null,
  indeterminate = false,
}: RemoveCompetitorDialogProps) {
  const { t } = useTranslation("analytics");

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("competitors.removeTitle", "Remove @{{username}}?", { username })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "competitors.removeBody",
              "Collection stops and a slot is freed. History is kept for 90 days, then eligible for cleanup.",
            )}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {errorMessage !== null && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {errorMessage}
          </p>
        )}
        {indeterminate && (
          <p role="alert" className="text-xs font-medium text-destructive">
            {t("competitors.outcomeUnknown", "Could not confirm the change. Reload to check.")}
          </p>
        )}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>
            {t("competitors.cancel", "Cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            disabled={isPending}
            onClick={(event) => {
              // The dialog stays open while the removal is in flight and
              // when it fails: only a confirmed removal closes it.
              event.preventDefault();
              onConfirm();
            }}
          >
            {isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : null}
            {isPending
              ? t("competitors.removing", "Removing")
              : t("competitors.confirmRemove", "Remove")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
