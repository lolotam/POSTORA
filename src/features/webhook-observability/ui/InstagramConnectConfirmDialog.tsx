import { useNavigate } from "react-router-dom";
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
import { Instagram } from "lucide-react";

export interface InstagramConnectConfirmation {
  socialAccountId: string;
  username: string | null;
  /** The id Meta will put in entry.id for this account. */
  webhookIdentity: string | null;
}

interface Props {
  confirmation: InstagramConnectConfirmation | null;
  onDismiss: () => void;
}

/**
 * Shown once after an Instagram account is connected.
 *
 * The failure this prevents: on 2026-08-24 a user connected one Instagram account and
 * then spent hours messaging a different one, with no signal anywhere that the two were
 * not the same. Naming the account at the moment of connection is the cheapest possible
 * place to catch that -- it turns a silent multi-hour dead end into an immediate "wait,
 * that's not the right account".
 */
export function InstagramConnectConfirmDialog({ confirmation, onDismiss }: Props) {
  const navigate = useNavigate();

  return (
    <AlertDialog open={!!confirmation} onOpenChange={(open) => !open && onDismiss()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="flex items-center gap-2">
            <Instagram className="h-5 w-5" />
            Is this the right Instagram account?
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-3">
              <p>
                You connected{" "}
                <strong>@{confirmation?.username ?? "this account"}</strong>.
              </p>
              <p>
                Automations will only run for direct messages and comments received by{" "}
                <strong>this</strong> account. Messages sent to any other Instagram profile
                you own will not trigger anything.
              </p>
              {confirmation?.webhookIdentity ? (
                <p className="text-xs text-muted-foreground">
                  Webhook identity:{" "}
                  <code className="font-mono">{confirmation.webhookIdentity}</code>
                </p>
              ) : null}
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel onClick={() => navigate("/profiles")}>
            Wrong account
          </AlertDialogCancel>
          <AlertDialogAction onClick={onDismiss}>Yes, that's correct</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
