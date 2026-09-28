import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { browserTimeZone, parseDatetimeLocal } from "../domain/wallClockMove";

function localInputValue(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return "";
  const pad = (part: number) => String(part).padStart(2, "0");
  return `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}T${pad(when.getHours())}:${pad(when.getMinutes())}`;
}

export function RescheduleWhatsAppDialog({
  open,
  recipientLabel,
  scheduledAt,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  recipientLabel: string;
  scheduledAt: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (scheduledAtIso: string) => void;
}) {
  const { t } = useTranslation("inbox");
  const { t: tCalendar } = useTranslation("calendar");
  const [localValue, setLocalValue] = useState(() => localInputValue(scheduledAt));
  const [missingHour, setMissingHour] = useState(false);
  const zone = browserTimeZone();

  const submit = () => {
    const resolved = parseDatetimeLocal(localValue);
    if (resolved.ok === false) {
      setMissingHour(resolved.reason === "nonexistent");
      return;
    }
    setMissingHour(false);
    onConfirm(resolved.when.toISOString());
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>{t("scheduled.rescheduleTitle", "Reschedule message")}</DialogTitle>
          <DialogDescription>
            {t("scheduled.rescheduleDesc", "Choose a new time for {{recipient}}.", { recipient: recipientLabel })}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm font-medium" htmlFor="whatsapp-reschedule-time">
            {t("scheduled.dateTime", "Date and time")}
          </label>
          <Input
            id="whatsapp-reschedule-time"
            type="datetime-local"
            value={localValue}
            onChange={(event) => {
              setLocalValue(event.target.value);
              setMissingHour(false);
            }}
          />
          {missingHour && (
            <p className="text-sm text-destructive" role="alert">
              {tCalendar("toast.missingHour", "That time does not exist on the selected day.")}
            </p>
          )}
          <p className="text-xs text-muted-foreground">
            {t("scheduled.timezoneLabel", "Timezone: {{zone}}", { zone })}
          </p>
        </div>
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={pending}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button type="button" onClick={submit} disabled={pending || !localValue}>
            {pending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t("scheduled.reschedule", "Reschedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function CancelWhatsAppDialog({
  open,
  recipientLabel,
  pending,
  onOpenChange,
  onConfirm,
}: {
  open: boolean;
  recipientLabel: string;
  pending: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation("inbox");
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("scheduled.cancelTitle", "Cancel scheduled message")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("scheduled.cancelDesc", "Cancel the message for {{recipient}}? This cannot be undone.", { recipient: recipientLabel })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{t("scheduled.keepMessage", "Keep message")}</AlertDialogCancel>
          <Button type="button" variant="destructive" onClick={onConfirm} disabled={pending}>
            {pending && <Loader2 className="me-2 h-4 w-4 animate-spin" />}
            {t("scheduled.cancelMessage", "Cancel message")}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
