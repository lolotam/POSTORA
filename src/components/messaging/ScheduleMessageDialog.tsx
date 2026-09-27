import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  isHttpsUrl,
  recipientDigits,
  SCHEDULED_OWN_ACCOUNT_ONLY,
  scheduledAtFromLocal,
  WHATSAPP_CAPTION_MAX,
  WHATSAPP_MESSAGE_MAX,
  useWhatsAppScheduledMessages,
  type OwnWhatsAppAccount,
} from "@/hooks/useWhatsAppScheduledMessages";

const MEDIA_TYPES = ["image", "video", "document", "audio"] as const;
type MediaType = (typeof MEDIA_TYPES)[number];
const NO_MEDIA = "none";

interface ScheduleMessageDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function accountLabel(account: OwnWhatsAppAccount): string {
  return account.platform_username || account.platform_user_id;
}

function localTimeZoneName(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function ScheduleMessageDialog({ open, onOpenChange }: ScheduleMessageDialogProps) {
  const { t } = useTranslation("inbox");
  const { accounts, accountsLoading, accountsError, schedule } = useWhatsAppScheduledMessages();
  const [accountId, setAccountId] = useState("");
  const [phone, setPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [mediaType, setMediaType] = useState<MediaType | "">("");
  const [mediaUrl, setMediaUrl] = useState("");
  const [whenLocal, setWhenLocal] = useState("");
  const [fieldError, setFieldError] = useState<Record<string, string>>({});

  useEffect(() => {
    if (open) return;
    setAccountId("");
    setPhone("");
    setRecipientName("");
    setMessage("");
    setMediaType("");
    setMediaUrl("");
    setWhenLocal("");
    setFieldError({});
  }, [open]);

  useEffect(() => {
    if (!open || accounts.length !== 1) return;
    setAccountId(accounts[0].id);
  }, [open, accounts]);

  const selected = accounts.find((account) => account.id === accountId) ?? null;
  const sessionWindow = selected?.connection_mode === "cloud_api" || selected?.connection_mode === "coexistence";
  const audio = mediaType === "audio";
  // With image, video or document media the text is sent as a caption.
  const textMax = mediaType !== "" && !audio ? WHATSAPP_CAPTION_MAX : WHATSAPP_MESSAGE_MAX;
  const noAccounts = !accountsLoading && !accountsError && accounts.length === 0;

  const handleSubmit = () => {
    const next: Record<string, string> = {};
    const digits = recipientDigits(phone);
    if (!accountId) next.account = t("scheduled.accountRequired", "Select a WhatsApp account.");
    if (!digits) next.phone = t("scheduled.phoneInvalid", "Enter a phone number with 8–15 digits. Letters, @ and extensions are not allowed.");

    const typeSet = mediaType !== "";
    const urlTrimmed = mediaUrl.trim();
    if (typeSet !== (urlTrimmed !== "")) {
      next.media = t("scheduled.mediaPair", "Choose a media type and an https URL together.");
    } else if (typeSet && !isHttpsUrl(urlTrimmed)) {
      next.media = t("scheduled.mediaUrlInvalid", "Media URL must be a valid https:// link.");
    }

    const text = message.trim();
    if (!audio && !text && !typeSet) {
      next.message = t("scheduled.messageRequired", "Write a message or attach media.");
    }
    if (text.length > textMax) {
      next.message = t("scheduled.messageTooLong", "Message must be {{max}} characters or fewer.", { max: textMax });
    }

    const scheduledAt = scheduledAtFromLocal(whenLocal);
    if (!scheduledAt) next.when = t("scheduled.timeInvalid", "Pick a time at least 1 minute from now.");

    setFieldError(next);
    if (Object.keys(next).length > 0 || !digits || !scheduledAt) return;

    const timeLabel = new Date(scheduledAt).toLocaleString(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    });
    schedule.mutate(
      {
        socialAccountId: accountId,
        recipientPhone: digits,
        recipientName: recipientName.trim() || undefined,
        messageText: audio ? undefined : text || undefined,
        mediaUrl: typeSet ? urlTrimmed : undefined,
        mediaType: typeSet ? mediaType : undefined,
        scheduledAt,
      },
      {
        onSuccess: () => {
          toast.success(t("scheduled.successToast", "Message scheduled for {{time}}", { time: timeLabel }));
          onOpenChange(false);
        },
        onError: (err: Error) => {
          toast.error(
            err.message === SCHEDULED_OWN_ACCOUNT_ONLY
              ? t("scheduled.ownAccountOnly", SCHEDULED_OWN_ACCOUNT_ONLY)
              : err.message,
          );
        },
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg max-h-[90vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>{t("scheduled.dialogTitle", "Schedule message")}</DialogTitle>
        </DialogHeader>
        <div className="space-y-4 flex-1 overflow-y-auto pe-1">
          <div className="space-y-1.5">
            <Label htmlFor="schedule-account">{t("scheduled.account", "WhatsApp account")}</Label>
            {accountsLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" />
              </div>
            ) : accountsError ? (
              <p role="alert" className="text-sm text-destructive">
                {t("scheduled.accountsError", "Couldn't load your WhatsApp accounts. Try again.")}
              </p>
            ) : noAccounts ? (
              <p className="text-sm text-muted-foreground">
                {t("scheduled.accountEmpty", "No active WhatsApp account. Connect one you own before scheduling.")}
              </p>
            ) : (
              <Select value={accountId} onValueChange={setAccountId}>
                <SelectTrigger id="schedule-account">
                  <SelectValue placeholder={t("scheduled.accountPlaceholder", "Select a WhatsApp account")} />
                </SelectTrigger>
                <SelectContent>
                  {accounts.map((account) => (
                    <SelectItem key={account.id} value={account.id}>
                      {accountLabel(account)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
            {fieldError.account && <p role="alert" className="text-xs text-destructive">{fieldError.account}</p>}
            {sessionWindow && (
              <p className="text-xs text-muted-foreground">
                {t(
                  "scheduled.sessionWindow",
                  "Free-form messages only deliver if the customer messaged within the last 24 hours. Otherwise the send fails with \"outside_session_window\". Templates are not supported for scheduling yet.",
                )}
              </p>
            )}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-phone">{t("scheduled.phone", "Recipient phone")}</Label>
            <Input
              id="schedule-phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              inputMode="tel"
              autoComplete="off"
              placeholder="+965 5000 1111"
            />
            {fieldError.phone && <p role="alert" className="text-xs text-destructive">{fieldError.phone}</p>}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="schedule-name">{t("scheduled.recipientName", "Recipient name (optional)")}</Label>
            <Input id="schedule-name" value={recipientName} onChange={(event) => setRecipientName(event.target.value)} />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="schedule-message">{t("scheduled.message", "Message")}</Label>
              {!audio && (
                <span className="text-xs text-muted-foreground">
                  {t("scheduled.characterCount", "{{count}} / {{max}}", { count: message.length, max: textMax })}
                </span>
              )}
            </div>
            <Textarea
              id="schedule-message"
              value={message}
              maxLength={WHATSAPP_MESSAGE_MAX}
              disabled={audio}
              onChange={(event) => setMessage(event.target.value)}
            />
            {audio && (
              <p className="text-xs text-muted-foreground">{t("scheduled.audioCaption", "Audio is sent without a caption.")}</p>
            )}
            {fieldError.message && <p role="alert" className="text-xs text-destructive">{fieldError.message}</p>}
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="schedule-media-type">{t("scheduled.mediaType", "Media type")}</Label>
              <Select
                value={mediaType || NO_MEDIA}
                onValueChange={(value) => {
                  if (value === NO_MEDIA) {
                    setMediaType("");
                    setMediaUrl("");
                  } else {
                    setMediaType(value as MediaType);
                  }
                }}
              >
                <SelectTrigger id="schedule-media-type">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NO_MEDIA}>{t("scheduled.mediaNone", "None")}</SelectItem>
                  <SelectItem value="image">{t("scheduled.mediaImage", "Image")}</SelectItem>
                  <SelectItem value="video">{t("scheduled.mediaVideo", "Video")}</SelectItem>
                  <SelectItem value="document">{t("scheduled.mediaDocument", "Document")}</SelectItem>
                  <SelectItem value="audio">{t("scheduled.mediaAudio", "Audio")}</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="schedule-media-url">{t("scheduled.mediaUrl", "Media URL")}</Label>
              <Input
                id="schedule-media-url"
                value={mediaUrl}
                onChange={(event) => setMediaUrl(event.target.value)}
                placeholder="https://"
                inputMode="url"
              />
            </div>
          </div>
          {fieldError.media && <p role="alert" className="text-xs text-destructive">{fieldError.media}</p>}

          <div className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="schedule-at">{t("scheduled.dateTime", "Date and time")}</Label>
              <span className="text-xs text-muted-foreground">{localTimeZoneName()}</span>
            </div>
            <Input
              id="schedule-at"
              type="datetime-local"
              value={whenLocal}
              onChange={(event) => setWhenLocal(event.target.value)}
            />
            {fieldError.when && <p role="alert" className="text-xs text-destructive">{fieldError.when}</p>}
          </div>
        </div>
        <DialogFooter className="pt-4">
          <Button type="button" onClick={handleSubmit} disabled={noAccounts || accountsLoading || accountsError || schedule.isPending}>
            {schedule.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {t("scheduled.submit", "Schedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
