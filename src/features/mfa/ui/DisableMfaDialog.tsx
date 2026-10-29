import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

interface DisableMfaDialogProps {
  open: boolean;
  submitting: boolean;
  codeError: string | null;
  onSubmit: (code: string) => void;
  onCancel: () => void;
}

/** Asks for an authenticator code before a verified 2FA factor is removed (AAL2 step-up). */
export function DisableMfaDialog({ open, submitting, codeError, onSubmit, onCancel }: DisableMfaDialogProps) {
  const { t } = useTranslation("accounts");
  const [code, setCode] = useState("");

  useEffect(() => {
    if (!open) setCode("");
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onCancel(); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("security.mfa.confirmDisableTitle", "Confirm it's you")}</DialogTitle>
          <DialogDescription>
            {t("security.mfa.confirmDisableDesc", "Enter the 6-digit code from your authenticator app to turn off two-factor authentication.")}
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (code.length === 6) onSubmit(code);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="disableMfaCode">{t("security.mfa.enterCode", "Enter verification code")}</Label>
            <Input
              id="disableMfaCode"
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              autoFocus
              className="text-center text-2xl tracking-widest font-mono"
              aria-invalid={codeError ? true : undefined}
            />
            {codeError && <p className="text-sm text-destructive text-center" role="alert">{codeError}</p>}
            <p className="text-xs text-muted-foreground text-center">
              {t("security.mfa.lostAuthenticator", "Lost your authenticator? Sign in with one of your backup codes instead.")}
            </p>
          </div>
          <div className="flex gap-3">
            <Button type="button" variant="outline" className="flex-1" onClick={onCancel} disabled={submitting}>
              {t("common:cancel", "Cancel")}
            </Button>
            <Button type="submit" variant="destructive" className="flex-1" disabled={submitting || code.length !== 6}>
              {submitting ? t("security.mfa.disabling", "Turning off…") : t("security.mfa.confirmDisable", "Turn off 2FA")}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
