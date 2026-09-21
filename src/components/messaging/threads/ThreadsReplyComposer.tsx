import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Loader2, Send, X } from "lucide-react";
import { cn } from "@/lib/utils";

interface Props {
  isPending?: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => void;
}

const LIMIT = 500;

export function ThreadsReplyComposer({ isPending, onCancel, onSubmit }: Props) {
  const { t } = useTranslation("threads");
  const [text, setText] = useState("");
  const trimmed = text.trim();
  const tooLong = text.length > LIMIT;
  const disabled = !trimmed || tooLong || !!isPending;

  return (
    <div className="rounded-md border bg-muted/30 p-3 space-y-2">
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t("form.replyOnThreads", "Reply on Threads…")}
        rows={3}
        autoFocus
        className="resize-none text-sm bg-background"
      />
      <div className="flex items-center justify-between gap-2">
        <span
          className={cn(
            "text-xs tabular-nums",
            tooLong ? "text-destructive font-medium" : "text-muted-foreground",
          )}
        >
          {text.length} / {LIMIT}
        </span>
        <div className="flex items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={onCancel}
            disabled={isPending}
          >
            <X className="h-3.5 w-3.5 me-1.5" />
            {t("common:cancel", "Cancel")}
          </Button>
          <Button
            type="button"
            size="sm"
            onClick={() => onSubmit(trimmed)}
            disabled={disabled}
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 me-1.5 animate-spin" />
            ) : (
              <Send className="h-3.5 w-3.5 me-1.5" />
            )}
            {t("actions.sendReply", "Send Reply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
