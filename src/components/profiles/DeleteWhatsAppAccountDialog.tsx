import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
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
import { AccountSetupSummaryList } from "@/components/messaging/AccountSetupSummaryList";
import { useWhatsAppSetupSummary } from "@/hooks/useWhatsAppSetupSummary";

// Structural minimum the dialog needs: the WhatsApp setup page and the Profiles
// account rows both satisfy it, so the dialog never depends on the full row type.
export interface DeleteWhatsAppAccountDialogProps {
  account: {
    id: string;
    platform_username: string | null;
    platform_user_id: string | null;
  } | null;
  onCancel: () => void;
  onConfirm: (accountId: string) => Promise<void>;
}

// One place decides what a refused delete means: the key is what the dialog translates,
// the message is the English fallback both callers share. 23503 = foreign key violation:
// connectors or partner integrations still reference the account, so the server refused
// the delete rather than orphaning them.
export function deleteAccountError(error: unknown): { key: string; message: string } {
  if ((error as { code?: string } | null)?.code === "23503") {
    return {
      key: "deleteWhatsApp.inUse",
      message: "This account can't be deleted while connectors or partner integrations use it. Disconnect it from the WhatsApp page instead.",
    };
  }
  return { key: "deleteWhatsApp.failed", message: "The account could not be deleted. Try again." };
}

export function deleteAccountErrorMessage(error: unknown): string {
  return deleteAccountError(error).message;
}

export function DeleteWhatsAppAccountDialog({
  account,
  onCancel,
  onConfirm,
}: DeleteWhatsAppAccountDialogProps) {
  const { t } = useTranslation("accounts");
  const summary = useWhatsAppSetupSummary(account?.id ?? null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    setErrorText(null);
    setDeleting(false);
  }, [account?.id]);

  if (!account) return null;

  const handleConfirm = async () => {
    setErrorText(null);
    setDeleting(true);
    try {
      await onConfirm(account.id);
    } catch (error) {
      const { key, message } = deleteAccountError(error);
      setErrorText(t(key, message));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <AlertDialog
      open
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("deleteWhatsApp.title", 'Delete "{{name}}"?', {
              name: account.platform_username ?? "WhatsApp",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription asChild>
            <div className="space-y-2 text-sm">
              <p>
                {t("deleteWhatsApp.warning", "This permanently deletes the account and its AI agent setup.")}
              </p>
              <AccountSetupSummaryList summary={summary.data} />
              <p className="text-muted-foreground">
                <Link
                  to="/messaging/whatsapp/setup"
                  className="text-primary underline-offset-4 hover:underline"
                >
                  {t("deleteWhatsApp.useSetupPageInstead", "Disconnect it on the WhatsApp page instead")}
                </Link>
              </p>
            </div>
          </AlertDialogDescription>
        </AlertDialogHeader>
        {summary.isError && (
          <p className="text-sm text-destructive">
            {t(
              "deleteWhatsApp.summaryFailed",
              "We couldn't load what is attached to this account. Try again later.",
            )}
          </p>
        )}
        {errorText && <p className="text-sm text-destructive">{errorText}</p>}
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common:cancel", "Cancel")}</AlertDialogCancel>
          <AlertDialogAction
            className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            disabled={deleting || !summary.data}
            onClick={(event) => {
              // Radix closes an AlertDialog on Action unless preventDefault is
              // called; the parent owns closing by clearing the account, and a
              // refused delete must leave the dialog (and its error) on screen.
              event.preventDefault();
              void handleConfirm();
            }}
          >
            {t("deleteWhatsApp.confirm", "Delete account")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
