import { useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { AlertCircle, Hash, ImagePlus, Loader2, Send, X } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useThreadsReplyMutations } from "@/hooks/useThreadsReplies";
import { MediaLibraryPicker } from "@/components/post/MediaLibraryPicker";
import { supabase } from "@/integrations/supabase/client";
import type { UploadedFile } from "@/hooks/usePostForm";

interface Props {
  accountId: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  replyToId: string | null;
  replyToPreview?: string | null;
  replyToUsername?: string | null;
  mediaId?: string | null;
}

const MAX_LEN = 500;

export function ThreadsReplyComposerDialog({
  accountId,
  open,
  onOpenChange,
  replyToId,
  replyToPreview,
  replyToUsername,
  mediaId,
}: Props) {
  const { t } = useTranslation("threads");
  const [text, setText] = useState("");
  const [topicTag, setTopicTag] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [attached, setAttached] = useState<
    | { url: string; type: "IMAGE" | "VIDEO"; previewUrl: string; name: string }
    | null
  >(null);
  const lastSubmitRef = useRef<{ text: string; at: number } | null>(null);
  const { createReply } = useThreadsReplyMutations(accountId);

  useEffect(() => {
    if (open) {
      setText("");
      setTopicTag("");
      setError(null);
      setAttached(null);
    }
  }, [open, replyToId]);

  const trimmed = text.trim();
  const overLimit = trimmed.length > MAX_LEN;
  const remaining = MAX_LEN - trimmed.length;

  // Topic tag — clean live, max 50, strip "." and "&"
  const cleanedTopicTag = topicTag.replace(/[.&]/g, "").slice(0, 50);
  const hasInvalidTagChars = /[.&]/.test(topicTag);

  const submit = () => {
    setError(null);
    if (!replyToId) {
      setError(t("errors.missingTarget", "Missing reply target"));
      return;
    }
    if (!trimmed && !attached) {
      setError(t("errors.needTextOrMedia", "Add some text or attach media to reply"));
      return;
    }
    if (createReply.isPending) return;
    // Duplicate-submit guard: same text within 2s
    const last = lastSubmitRef.current;
    if (last && last.text === trimmed && Date.now() - last.at < 2000) return;
    lastSubmitRef.current = { text: trimmed, at: Date.now() };

    createReply.mutate(
      {
        reply_to_id: replyToId,
        text: trimmed,
        media_id: mediaId ?? undefined,
        ...(attached ? { media_type: attached.type, media_url: attached.url } : {}),
        ...(cleanedTopicTag ? { topic_tag: cleanedTopicTag } : {}),
      },
      {
        onSuccess: () => onOpenChange(false),
        onError: (e: Error) => setError(e?.message || t("errors.couldNotSend", "Could not send reply")),
      },
    );
  };

  const handleMediaSelect = (files: UploadedFile[]) => {
    const file = files[0];
    if (!file) return;
    if (file.fileType === "gif") {
      setError(t("errors.gifNotSupported", "Threads does not support GIF replies. Pick an image or video."));
      return;
    }
    let url = file.cloudinaryUrl || "";
    if (!url && file.storagePath) {
      const { data } = supabase.storage.from("media").getPublicUrl(file.storagePath);
      url = data?.publicUrl || "";
    }
    if (!url) {
      setError(t("errors.publicUrl", "Could not resolve a public URL for that file."));
      return;
    }
    if (!/^https:\/\//i.test(url)) {
      setError(t("errors.httpsRequired", "Selected media must be served over HTTPS."));
      return;
    }
    setError(null);
    setAttached({
      url,
      type: file.fileType === "video" ? "VIDEO" : "IMAGE",
      previewUrl: file.previewUrl || url,
      name: file.file?.name || t("form.attachmentName", "attachment"),
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[520px]">
        <DialogHeader>
          <DialogTitle>{t("dialog.replyOnThreads", "Reply on Threads")}</DialogTitle>
          <DialogDescription>
            {replyToUsername
              ? t("dialog.replyingTo", "Replying to @{{username}}", { username: replyToUsername })
              : t("dialog.composeReply", "Compose your reply")}
          </DialogDescription>
        </DialogHeader>

        {replyToPreview && (
          <div className="rounded-md border bg-muted/40 p-3 text-sm text-muted-foreground line-clamp-3">
            {replyToPreview}
          </div>
        )}

        {/* Media attachment (optional) */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <ImagePlus className="w-4 h-4" />
            {t("form.mediaOptional", "Media (optional)")}
          </Label>
          {attached ? (
            <div className="flex items-center gap-3 rounded-md border p-2">
              <div className="h-16 w-16 shrink-0 overflow-hidden rounded-md bg-muted">
                {attached.type === "VIDEO" ? (
                  <video src={attached.previewUrl} className="h-full w-full object-cover" muted />
                ) : (
                  <img src={attached.previewUrl} alt={attached.name} className="h-full w-full object-cover" />
                )}
              </div>
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm">{attached.name}</p>
                <p className="text-xs text-muted-foreground">{attached.type}</p>
              </div>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setAttached(null)}
                disabled={createReply.isPending}
              >
                <X className="h-4 w-4" />
              </Button>
            </div>
          ) : (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPickerOpen(true)}
              disabled={createReply.isPending}
            >
              <ImagePlus className="mr-2 h-4 w-4" />
              {t("actions.chooseFromLibrary", "Choose from Library")}
            </Button>
          )}
          <p className="text-xs text-muted-foreground">
            {t("form.mediaOnePerReply", "Threads supports one image or one video per reply.")}
          </p>
        </div>

        {/* Topic Tag (optional) — Threads-only, sent as topic_tag to Meta */}
        <div className="space-y-2">
          <Label className="text-sm font-medium flex items-center gap-2">
            <Hash className="w-4 h-4" />
            {t("form.topicTag", "Topic Tag (optional)")}
          </Label>
          <Input
            placeholder={t("form.topicPlaceholder", "e.g. lovable-build")}
            value={topicTag}
            onChange={(e) => setTopicTag(e.target.value)}
            maxLength={50}
            disabled={createReply.isPending}
          />
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground">
              {t("form.topicHint", "Adds a clickable topic above your reply. 1–50 characters. No periods (.) or ampersands (&).")}
            </p>
            <p className="text-xs text-muted-foreground shrink-0">{cleanedTopicTag.length}/50</p>
          </div>
          {hasInvalidTagChars && (
            <div className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded-md p-2">
              <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
              <span>
                {t(
                  "form.topicInvalid",
                  "Periods (.) and ampersands (&) are not allowed and will be removed before publishing{{cleaned}}.",
                  { cleaned: cleanedTopicTag.length > 0 ? ` → "${cleanedTopicTag}"` : "" },
                )}
              </span>
            </div>
          )}
        </div>

        <Textarea
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("form.writeReply", "Write your reply…")}
          rows={5}
          disabled={createReply.isPending}
        />

        <div className="flex items-center justify-between text-xs">
          <span className="text-muted-foreground">
            <Trans
              ns="threads"
              i18nKey="form.pressEnter"
              defaults="Press <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for new line"
              components={{ kbd: <kbd className="px-1 rounded bg-muted" /> }}
            />
          </span>
          <span className={overLimit ? "text-destructive" : "text-muted-foreground"}>
            {remaining}
          </span>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={createReply.isPending}>
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            onClick={submit}
            disabled={createReply.isPending || (trimmed.length === 0 && !attached)}
          >
            {createReply.isPending ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {t("actions.sendReply", "Send Reply")}
          </Button>
        </DialogFooter>
      </DialogContent>
      <MediaLibraryPicker
        open={pickerOpen}
        onOpenChange={setPickerOpen}
        onSelect={(files) => {
          handleMediaSelect(files);
          setPickerOpen(false);
        }}
        maxFiles={1}
      />
    </Dialog>
  );
}