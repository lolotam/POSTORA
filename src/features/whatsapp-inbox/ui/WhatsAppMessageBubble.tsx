import { format } from "date-fns";
import { Contact, MapPin } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { Message } from "@/hooks/useMessaging";
import type { WhatsAppAttachment } from "../application/ports";
import { WhatsAppMediaAttachment } from "./WhatsAppMediaAttachment";

export type WhatsAppMessage = Message & {
  media_understanding?: string | null;
};

interface WhatsAppMessageBubbleProps {
  message: WhatsAppMessage;
  isSent: boolean;
}

function isInboxAttachment(value: Message["attachments"][number]): value is Message["attachments"][number] & WhatsAppAttachment {
  const candidate = value as WhatsAppAttachment;
  return typeof candidate.kind === "string" && typeof candidate.message_row_id === "string";
}

function inboxAttachments(message: WhatsAppMessage): WhatsAppAttachment[] {
  return (message.attachments ?? []).filter(isInboxAttachment).map((attachment) => ({
    kind: attachment.kind,
    message_row_id: attachment.message_row_id,
    mime_type: attachment.mime_type ?? null,
    name: attachment.name ?? null,
    needs_fetch: attachment.needs_fetch ?? true,
    file_url: attachment.file_url ?? null,
    duration_seconds: "duration_seconds" in attachment
      ? (attachment as WhatsAppAttachment).duration_seconds
      : undefined,
  }));
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
  const attachments = inboxAttachments(message);
  const understanding = message.media_understanding?.trim();

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
        {attachments.map((attachment) => (
          <WhatsAppMediaAttachment
            key={attachment.message_row_id}
            attachment={attachment}
            createdTime={message.created_time}
          />
        ))}
      </div>
      {understanding ? (
        <Collapsible className="mt-1 max-w-full">
          <CollapsibleTrigger
            className="text-[11px] text-muted-foreground underline-offset-2 hover:underline"
          >
            AI description
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="mt-1 text-[11px] text-muted-foreground">{understanding}</p>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
      <span className="mt-0.5 text-[10px] text-muted-foreground">
        {format(new Date(message.created_time), "MMM d, h:mm a")}
      </span>
    </div>
  );
}
