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

interface UnsavedChangesDialogProps {
  open: boolean;
  onCancel: () => void;
  onDiscard: () => void;
}

export function UnsavedChangesDialog({ open, onCancel, onDiscard }: UnsavedChangesDialogProps) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>You have unsaved changes</AlertDialogTitle>
          <AlertDialogDescription>
            Your edits to this agent have not been saved. Discarding will lose them.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          {/* Cancel is the safe action, so it keeps default focus and wins a stray Enter. */}
          <AlertDialogCancel onClick={onCancel}>Keep editing</AlertDialogCancel>
          <AlertDialogAction
            onClick={onDiscard}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            Discard changes
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
