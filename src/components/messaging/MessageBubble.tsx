import { useTranslation } from "react-i18next";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { Trash2, FileIcon, Download, MapPin, Contact, Reply } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { Message } from "@/hooks/useMessaging";

interface MessageBubbleProps {
  message: Message;
  isSent: boolean;
  onDelete?: (messageId: string) => void;
}

function MediaRenderer({ attachments }: { attachments: Message["attachments"] }) {
  const { t } = useTranslation("inbox");
  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      {attachments.map((att, i) => (
        <div key={i} className="mt-2">
          {att.image_data?.url && (
            <a href={att.image_data.url} target="_blank" rel="noopener noreferrer">
              <img src={att.image_data.url} alt={t("bubble.attachmentAlt", "attachment")} className="rounded-lg max-w-full max-h-48 object-cover cursor-pointer hover:opacity-90 transition-opacity" />
            </a>
          )}
          {att.video_data?.url && (
            <video src={att.video_data.url} controls className="rounded-lg max-w-full max-h-48" />
          )}
          {att.file_url && !att.image_data && !att.video_data && (
            <a href={att.file_url} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 p-2 rounded-lg bg-background/50 hover:bg-background/80 transition-colors">
              <FileIcon className="h-4 w-4 shrink-0" />
              <span className="text-xs underline truncate">{att.name || t("bubble.downloadFile", "Download file")}</span>
              <Download className="h-3 w-3 shrink-0 ml-auto" />
            </a>
          )}
        </div>
      ))}
    </>
  );
}

function InlineMediaFromText({ text }: { text: string }) {
  // Render placeholders for WhatsApp media types with richer UI
  if (text.startsWith("[Location]")) {
    const coords = text.replace("[Location] ", "");
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        <span>{coords}</span>
      </div>
    );
  }
  if (text.startsWith("[Contact]")) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <Contact className="h-3.5 w-3.5 shrink-0" />
        <span>{text.replace("[Contact] ", "")}</span>
      </div>
    );
  }
  if (text.startsWith("[Reaction]")) {
    return <span className="text-2xl">{text.replace("[Reaction] ", "")}</span>;
  }
  return null;
}

function InteractiveResponseBadge({ text }: { text: string }) {
  // Render interactive button/list replies with a styled badge
  if (!text.startsWith("[Interactive]") && !text.includes("button_reply") && !text.includes("list_reply")) return null;
  return (
    <div className="flex items-center gap-1.5 mt-1">
      <Reply className="h-3 w-3 shrink-0" />
      <span className="text-xs font-medium">{text}</span>
    </div>
  );
}

export function MessageBubble({ message, isSent, onDelete }: MessageBubbleProps) {
  const hasSpecialInline = message.message && (
    message.message.startsWith("[Location]") ||
    message.message.startsWith("[Contact]") ||
    message.message.startsWith("[Reaction]")
  );

  return (
    <div className={cn("flex flex-col max-w-[75%] group", isSent ? "ml-auto items-end" : "items-start")}>
      <span className="text-xs text-muted-foreground mb-1">{message.from?.name}</span>
      <div
        className={cn(
          "rounded-2xl px-4 py-2 text-sm relative",
          isSent
            ? "bg-primary text-primary-foreground rounded-br-sm"
            : "bg-muted text-foreground rounded-bl-sm"
        )}
      >
        {hasSpecialInline ? (
          <InlineMediaFromText text={message.message} />
        ) : message.message ? (
          <p className="whitespace-pre-wrap">{message.message}</p>
        ) : null}
        <MediaRenderer attachments={message.attachments} />
        {onDelete && (
          <Button
            variant="ghost"
            size="icon"
            className="absolute -top-2 -right-8 opacity-0 group-hover:opacity-100 h-6 w-6 transition-opacity"
            onClick={() => onDelete(message.id)}
          >
            <Trash2 className="w-3 h-3 text-destructive" />
          </Button>
        )}
      </div>
      <span className="text-[10px] text-muted-foreground mt-0.5">
        {format(new Date(message.created_time), "MMM d, h:mm a")}
      </span>
    </div>
  );
}
