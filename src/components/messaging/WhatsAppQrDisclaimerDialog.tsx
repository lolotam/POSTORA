import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import "@/i18n";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface WhatsAppQrDisclaimerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onProceed: () => void;
}

export function WhatsAppQrDisclaimerDialog({ open, onOpenChange, onProceed }: WhatsAppQrDisclaimerDialogProps) {
  const { t } = useTranslation("whatsapp");
  const [accepted, setAccepted] = useState(false);

  useEffect(() => {
    if (!open) setAccepted(false);
  }, [open]);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        onEscapeKeyDown={(event) => event.preventDefault()}
        onPointerDownOutside={(event) => event.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>{t("qr.title", "Before you connect with Direct QR")}</DialogTitle>
          <DialogDescription>
            {t("qr.description", "Direct QR mode uses a self-hosted WhatsApp session rather than Meta's Cloud API. It may be disconnected or restricted by WhatsApp, and you are responsible for following WhatsApp's terms and messaging policies.")}
          </DialogDescription>
        </DialogHeader>
        <label className="flex items-start gap-3 rounded-md border p-3 text-sm">
          <Checkbox checked={accepted} onCheckedChange={(checked) => setAccepted(checked === true)} />
          <span>{t("qr.accept", "I understand the risks and want to continue with Direct QR mode.")}</span>
        </label>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>{t("common:cancel", "Cancel")}</Button>
          <Button disabled={!accepted} onClick={onProceed}>{t("qr.continue", "Continue to QR scanner")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
