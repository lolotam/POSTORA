import { useState } from "react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription,
  AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Loader2 } from "lucide-react";

interface RevokePartnerKeyDialogProps {
  keyName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (reason: string) => void;
  isPending: boolean;
}

/** Revocation is one-way (spec D5): a reason is required and there is no undo. */
export function RevokePartnerKeyDialog({ keyName, open, onOpenChange, onConfirm, isPending }: RevokePartnerKeyDialogProps) {
  const [reason, setReason] = useState("");
  const trimmed = reason.trim();
  return (
    <AlertDialog open={open} onOpenChange={(next) => { if (!next) setReason(""); onOpenChange(next); }}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Revoke “{keyName}”?</AlertDialogTitle>
          <AlertDialogDescription>
            Every request using this key will be refused immediately. This cannot be undone; mint a new key to restore access.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <div className="space-y-2">
          <Label htmlFor="revoke-reason">Reason (recorded in the audit trail)</Label>
          <Textarea id="revoke-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. credential leaked in partner logs" />
        </div>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            disabled={trimmed.length === 0 || isPending}
            onClick={(e) => { e.preventDefault(); onConfirm(trimmed); }}
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
          >
            {isPending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            Revoke key
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
