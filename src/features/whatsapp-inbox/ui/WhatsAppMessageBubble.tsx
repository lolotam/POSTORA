import { format } from "date-fns";
import { Contact, Download, FileIcon, MapPin } from "lucide-react";
import { cn } from "@/lib/utils";
import type { Message } from "@/hooks/useMessaging";

export type WhatsAppMessage = Message;

interface WhatsAppMessageBubbleProps {
  message: WhatsAppMessage;
  isSent: boolean;
}

function MediaRenderer({ attachments }: { attachments: WhatsAppMessage["attachments"] }) {
  if (!attachments || attachments.length === 0) return null;

  return (
    <>
      {attachments.map((attachment, index) => (
        <div key={index} className="mt-2">
          {attachment.image_data?.url && (
            <a href={attachment.image_data.url} target="_blank" rel="noopener noreferrer">
              <img
                src={attachment.image_data.url}
                alt="attachment"
                className="max-h-48 max-w-full cursor-pointer rounded-lg object-cover transition-opacity hover:opacity-90"
              />
            </a>
          )}
          {attachment.video_data?.url && (
            <video src={attachment.video_data.url} controls className="max-h-48 max-w-full rounded-lg" />
          )}
          {attachment.file_url && !attachment.image_data && !attachment.video_data && (
            <a
              href={attachment.file_url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-2 rounded-lg bg-background/50 p-2 transition-colors hover:bg-background/80"
            >
              <FileIcon className="h-4 w-4 shrink-0" />
              <span className="truncate text-xs underline">{attachment.name || "Download file"}</span>
              <Download className="ml-auto h-3 w-3 shrink-0" />
            </a>
          )}
        </div>
      ))}
    </>
  );
}

function InlineMediaFromText({ text }: { text: string }) {
  if (text.startsWith("[Location]")) {
    return (
      <div className="flex items-center gap-1.5 text-xs">
        <MapPin className="h-3.5 w-3.5 shrink-0" />
        <span>{text.replace("[Location] ", "")}</span>
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

export function WhatsAppMessageBubble({ message, isSent }: WhatsAppMessageBubbleProps): JSX.Element {
  const hasSpecialInline = message.message && (
    message.message.startsWith("[Location]")
    || message.message.startsWith("[Contact]")
    || message.message.startsWith("[Reaction]")
  );

  return (
    <div className={cn("group flex max-w-[75%] flex-col", isSent ? "ml-auto items-end" : "items-start")}>
      <span className="mb-1 text-xs text-muted-foreground">{message.from?.name}</span>
      <div
        className={cn(
          "relative rounded-2xl px-4 py-2 text-sm",
          isSent
            ? "rounded-br-sm bg-primary text-primary-foreground"
            : "rounded-bl-sm bg-muted text-foreground",
        )}
      >
        {hasSpecialInline ? (
          <InlineMediaFromText text={message.message} />
        ) : message.message ? (
          <p className="whitespace-pre-wrap">{message.message}</p>
        ) : null}
        <MediaRenderer attachments={message.attachments} />
      </div>
      <span className="mt-0.5 text-[10px] text-muted-foreground">
        {format(new Date(message.created_time), "MMM d, h:mm a")}
      </span>
    </div>
  );
}
