import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import { Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Textarea } from "@/components/ui/textarea";
import { supabase } from "@/integrations/supabase/client";
import { useQuotas } from "@/hooks/useQuotas";
import { readUploadRefusal } from "@/components/media/uploadErrors";
import { ScheduleLibraryPicker, type ScheduleLibraryFile } from "@/components/messaging/ScheduleLibraryPicker";
import { sanitizeMediaFilename } from "@/lib/mediaFilename";
import {
  MEDIA_DECODED_BYTE_CAP,
  MEDIA_TYPES,
  downloadNameFor,
  extensionOfName,
  mediaTypeForFileName,
  uploadFileTypeFor,
  type MediaTypeEntry,
} from "@/lib/mediaTypes";
import {
  CLOUD_SIZE_LIMITS_MB,
  cloudAccount,
  exceedsCloudSizeLimit,
  scheduledMessageType,
  type ScheduledMediaType,
} from "@/lib/scheduledMedia";
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

const MEDIA_TYPES_UI = ["image", "video", "document", "audio"] as const;
type MediaType = (typeof MEDIA_TYPES_UI)[number];
type MediaSource = "none" | "upload" | "library" | "link";

/** Same allow-list as the Library. */
const UPLOAD_ACCEPT = Object.keys(MEDIA_TYPES).map((extension) => `.${extension}`).join(",");

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

function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error ?? new Error("read_failed"));
    reader.readAsDataURL(file);
  });
}

export function ScheduleMessageDialog({ open, onOpenChange }: ScheduleMessageDialogProps) {
  const { t } = useTranslation("inbox");
  const { accounts, accountsLoading, accountsError, schedule } = useWhatsAppScheduledMessages();
  const { canUploadMedia, incrementMediaUpload } = useQuotas();
  const [accountId, setAccountId] = useState("");
  const [phone, setPhone] = useState("");
  const [recipientName, setRecipientName] = useState("");
  const [message, setMessage] = useState("");
  const [mediaSource, setMediaSource] = useState<MediaSource>("none");
  const [mediaUrl, setMediaUrl] = useState("");
  const [linkType, setLinkType] = useState<MediaType | "">("");
  const [mediaFilename, setMediaFilename] = useState("");
  const [picked, setPicked] = useState<{ name: string; size: number } | null>(null);
  const [libraryPick, setLibraryPick] = useState<{ id: string; name: string; size: number | null } | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadIssue, setUploadIssue] = useState<string | null>(null);
  const [libraryIssue, setLibraryIssue] = useState<string | null>(null);
  const [whenLocal, setWhenLocal] = useState("");
  const [fieldError, setFieldError] = useState<Record<string, string>>({});
  // A stale completion (dialog closed or reopened, or a different file
  // picked) must never fill the media fields. Invalidating also drops
  // `uploading`: the superseded run's finally bails out on the token and
  // cannot clear the flag itself.
  const uploadTokenRef = useRef(0);
  const invalidateInFlightUpload = useCallback(() => {
    uploadTokenRef.current += 1;
    setUploading(false);
  }, []);

  useEffect(() => {
    if (open) return;
    invalidateInFlightUpload();
    setAccountId("");
    setPhone("");
    setRecipientName("");
    setMessage("");
    setMediaSource("none");
    setMediaUrl("");
    setLinkType("");
    setMediaFilename("");
    setPicked(null);
    setLibraryPick(null);
    setUploadIssue(null);
    setLibraryIssue(null);
    setWhenLocal("");
    setFieldError({});
  }, [open, invalidateInFlightUpload]);

  useEffect(() => {
    if (!open || accounts.length !== 1) return;
    setAccountId(accounts[0].id);
  }, [open, accounts]);

  const selected = accounts.find((account) => account.id === accountId) ?? null;
  const sessionWindow = selected?.connection_mode === "cloud_api" || selected?.connection_mode === "coexistence";
  const cloud = cloudAccount(selected?.connection_mode);

  const activeName = mediaSource === "upload"
    ? picked?.name ?? null
    : mediaSource === "library"
      ? libraryPick?.name ?? null
      : null;
  const activeSize = mediaSource === "upload"
    ? picked?.size ?? null
    : mediaSource === "library"
      ? libraryPick?.size ?? null
      : null;
  const derivedType = activeName ? scheduledMessageType(extensionOfName(activeName), cloud) : null;
  const effectiveType: ScheduledMediaType | null = mediaSource === "link" ? linkType || null : derivedType;
  const audio = effectiveType === "audio";
  // With image, video or document media the text is sent as a caption.
  const textMax = effectiveType !== null && !audio ? WHATSAPP_CAPTION_MAX : WHATSAPP_MESSAGE_MAX;
  const noAccounts = !accountsLoading && !accountsError && accounts.length === 0;

  // Per-account rules, re-validated whenever the account or the media
  // selection changes. Null when nothing is selected yet.
  const mediaBlocker = useMemo<string | null>(() => {
    const label = (type: ScheduledMediaType): string =>
      type === "image"
        ? t("scheduled.mediaImage", "Image")
        : type === "video"
          ? t("scheduled.mediaVideo", "Video")
          : type === "audio"
            ? t("scheduled.mediaAudio", "Audio")
            : t("scheduled.mediaDocument", "Document");
    if (!selected) return null;
    if (mediaSource === "upload" || mediaSource === "library") {
      if (!activeName || !cloud) return null;
      const extension = extensionOfName(activeName);
      if (!scheduledMessageType(extension, true)) {
        return t("scheduled.cloudTypeRefused", "WhatsApp Cloud API doesn't accept .{{ext}} files. Use a QR account or convert it.", { ext: extension || "?" });
      }
      if (effectiveType && exceedsCloudSizeLimit(effectiveType, activeSize)) {
        return t("scheduled.cloudFileTooLarge", "WhatsApp Cloud API accepts {{kind}} up to {{limit}}.", {
          kind: label(effectiveType),
          limit: `${CLOUD_SIZE_LIMITS_MB[effectiveType]} MB`,
        });
      }
      return null;
    }
    if (mediaSource === "link" && linkType && isHttpsUrl(mediaUrl) && cloud) {
      const extension = extensionOfName(mediaUrl);
      if (!extension) {
        return t("scheduled.cloudLinkMissing", "WhatsApp Cloud API needs a link that ends in a known file extension.");
      }
      const derived = scheduledMessageType(extension, true);
      if (!derived) {
        return t("scheduled.cloudTypeRefused", "WhatsApp Cloud API doesn't accept .{{ext}} files. Use a QR account or convert it.", { ext: extension });
      }
      if (derived !== linkType) {
        return t("scheduled.cloudLinkMismatch", "This link is a .{{ext}} file — pick {{type}} as the media type.", {
          ext: extension,
          type: label(derived),
        });
      }
    }
    return null;
  }, [selected, mediaSource, activeName, activeSize, effectiveType, linkType, mediaUrl, cloud, t]);

  const clearMedia = () => {
    setMediaUrl("");
    setLinkType("");
    setMediaFilename("");
    setPicked(null);
    setLibraryPick(null);
    setUploadIssue(null);
    setLibraryIssue(null);
  };

  const handleSourceChange = (value: string) => {
    invalidateInFlightUpload();
    setMediaSource(value as MediaSource);
    clearMedia();
  };

  const runUpload = async (file: File, entry: MediaTypeEntry, token: number) => {
    if (uploadTokenRef.current !== token) return;
    setUploading(true);
    try {
      const quotaCheck = await canUploadMedia();
      if (uploadTokenRef.current !== token) return;
      if (!quotaCheck.allowed) {
        setUploadIssue(quotaCheck.message || t("scheduled.uploadLimitReached", "Daily upload limit reached."));
        return;
      }
      if (!(await incrementMediaUpload())) {
        if (uploadTokenRef.current !== token) return;
        setUploadIssue(t("scheduled.uploadLimitReached", "Daily upload limit reached."));
        return;
      }
      const fileData = await readFileAsDataUrl(file);
      const { data, error } = await supabase.functions.invoke("cloudinary-upload", {
        body: {
          fileData,
          fileName: file.name,
          fileType: uploadFileTypeFor(entry.kind),
        },
      });
      if (error) throw error;
      if (!(data?.success && data?.mediaFileId)) throw new Error((data as { error?: string })?.error || "Upload failed");
      if (uploadTokenRef.current !== token) return;
      setMediaUrl(String(data.url));
      setMediaFilename(sanitizeMediaFilename(file.name));
    } catch (uploadError) {
      if (uploadTokenRef.current !== token) return;
      const detail = await readUploadRefusal(uploadError);
      setUploadIssue(detail || t("scheduled.uploadFailed", "Couldn't upload {{name}}.", { name: file.name }));
    } finally {
      if (uploadTokenRef.current === token) setUploading(false);
    }
  };

  const handleFilePick = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    invalidateInFlightUpload();
    const token = uploadTokenRef.current;
    setPicked({ name: file.name, size: file.size });
    setMediaUrl("");
    setMediaFilename("");
    setUploadIssue(null);
    const entry = mediaTypeForFileName(file.name);
    if (!entry) {
      setUploadIssue(t("scheduled.uploadTypeRejected", "{{name}} is not an allowed file type.", { name: file.name }));
      return;
    }
    if (file.size > MEDIA_DECODED_BYTE_CAP) {
      setUploadIssue(t("scheduled.uploadTooLarge", "{{name}} is over the 10 MB limit.", { name: file.name }));
      return;
    }
    void runUpload(file, entry, token);
  };

  const handleLibraryPick = (file: ScheduleLibraryFile, url: string) => {
    invalidateInFlightUpload();
    if (!url) {
      // Drop the previous file entirely. Keeping it would let Schedule send
      // file A after the user chose an unresolvable file B.
      clearMedia();
      setLibraryIssue(t(
        "scheduled.libraryFileUnavailable",
        "This file isn't available right now. Pick another file or upload it again.",
      ));
      return;
    }
    setPicked(null);
    setUploadIssue(null);
    setLibraryIssue(null);
    const name = downloadNameFor(file);
    setLibraryPick({ id: file.id, name, size: file.file_size });
    setMediaUrl(url);
    setMediaFilename(sanitizeMediaFilename(name));
  };

  const handleSubmit = () => {
    const next: Record<string, string> = {};
    const digits = recipientDigits(phone);
    if (!accountId) next.account = t("scheduled.accountRequired", "Select a WhatsApp account.");
    if (!digits) next.phone = t("scheduled.phoneInvalid", "Enter a phone number with 8–15 digits. Letters, @ and extensions are not allowed.");

    const typeSet = effectiveType !== null;
    const urlTrimmed = mediaUrl.trim();
    if (mediaSource === "none") {
      if (typeSet || urlTrimmed) next.media = t("scheduled.mediaPair", "Choose a media type and an https URL together.");
    } else if (mediaSource === "link") {
      if (typeSet !== (urlTrimmed !== "")) {
        next.media = t("scheduled.mediaPair", "Choose a media type and an https URL together.");
      } else if (typeSet && !isHttpsUrl(urlTrimmed)) {
        next.media = t("scheduled.mediaUrlInvalid", "Media URL must be a valid https:// link.");
      }
    } else if (mediaSource === "library" && libraryIssue) {
      next.media = libraryIssue;
    } else if (!typeSet || !urlTrimmed) {
      next.media = mediaSource === "upload"
        ? t("scheduled.uploadRequired", "Upload a file first.")
        : t("scheduled.libraryRequired", "Pick a file from your Library.");
    }
    if (!next.media && mediaBlocker) next.media = mediaBlocker;

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
        mediaType: typeSet ? effectiveType : undefined,
        mediaFilename: typeSet && (mediaSource === "upload" || mediaSource === "library")
          ? mediaFilename.trim() || undefined
          : undefined,
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

          <div className="space-y-1.5">
            <Label>{t("scheduled.media", "Media")}</Label>
            <Tabs value={mediaSource} onValueChange={handleSourceChange}>
              <TabsList className="grid w-full grid-cols-4">
                <TabsTrigger value="none">{t("scheduled.mediaNone", "None")}</TabsTrigger>
                <TabsTrigger value="upload">{t("scheduled.mediaSourceUpload", "Upload file")}</TabsTrigger>
                <TabsTrigger value="library">{t("scheduled.mediaSourceLibrary", "Choose from Library")}</TabsTrigger>
                <TabsTrigger value="link">{t("scheduled.mediaSourceLink", "Paste link")}</TabsTrigger>
              </TabsList>
              <TabsContent value="upload" className="space-y-2 pt-3">
                <div className="space-y-1.5">
                  <Label htmlFor="schedule-upload">{t("scheduled.uploadPick", "Choose a file")}</Label>
                  <Input id="schedule-upload" type="file" accept={UPLOAD_ACCEPT} onChange={handleFilePick} />
                </div>
                <p className="text-xs text-muted-foreground">
                  {t("scheduled.uploadHint", "Up to 10 MB. The file is stored in your Library too.")}
                </p>
                {uploading && picked && (
                  <p className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {t("scheduled.uploadProgress", "Uploading {{name}}…", { name: picked.name })}
                  </p>
                )}
                {!uploading && picked && mediaUrl && (
                  <p className="text-xs text-muted-foreground">
                    {t("scheduled.uploadSelected", "Selected: {{name}}", { name: picked.name })}
                  </p>
                )}
                {uploadIssue && <p role="alert" className="text-xs text-destructive">{uploadIssue}</p>}
              </TabsContent>
              <TabsContent value="library" className="space-y-2 pt-3">
                <ScheduleLibraryPicker
                  active={mediaSource === "library"}
                  selectedId={libraryPick?.id ?? null}
                  onPick={handleLibraryPick}
                />
                {libraryIssue && <p role="alert" className="text-xs text-destructive">{libraryIssue}</p>}
              </TabsContent>
              <TabsContent value="link" className="space-y-3 pt-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="schedule-media-type">{t("scheduled.mediaType", "Media type")}</Label>
                    <Select value={linkType} onValueChange={(value) => setLinkType(value as MediaType)}>
                      <SelectTrigger id="schedule-media-type">
                        <SelectValue placeholder={t("scheduled.mediaType", "Media type")} />
                      </SelectTrigger>
                      <SelectContent>
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
                <p className="text-xs text-muted-foreground">
                  {t("scheduled.codecHint", "Video: MP4 (H.264/AAC). Audio: MP3 or OGG (Opus).")}
                </p>
              </TabsContent>
            </Tabs>
            {mediaBlocker && <p role="alert" className="text-xs text-destructive">{mediaBlocker}</p>}
            {fieldError.media && <p role="alert" className="text-xs text-destructive">{fieldError.media}</p>}
          </div>

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
          <Button
            type="button"
            onClick={handleSubmit}
            disabled={noAccounts || accountsLoading || accountsError || schedule.isPending || uploading || !!mediaBlocker || !!libraryIssue}
          >
            {schedule.isPending && <Loader2 className="h-4 w-4 me-2 animate-spin" />}
            {t("scheduled.submit", "Schedule")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
