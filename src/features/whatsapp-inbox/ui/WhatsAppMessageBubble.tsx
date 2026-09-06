import { Contact, MapPin } from "lucide-react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import type { WhatsAppAttachment, WhatsAppMessage } from "../application/ports";
import { formatBubbleTime } from "../domain/messageStatus";
import type { WhatsAppConnectionMode } from "../domain/whatsappCapabilities";
import { WhatsAppMediaAttachment } from "./WhatsAppMediaAttachment";
import { WhatsAppMessageContextMenu } from "./WhatsAppMessageContextMenu";
import { WhatsAppStatusTicks } from "./WhatsAppStatusTicks";

export type { WhatsAppMessage };

interface WhatsAppMessageBubbleProps {
  message: WhatsAppMessage;
  isSent: boolean;
  connectionMode?: WhatsAppConnectionMode;
  onForward?(): void;
  onPin?(): void;
  onUnpin?(): void;
  onHide?(): void;
  onRevoke?(): void;
}

function isInboxAttachment(value: WhatsAppMessage["attachments"][number]): value is WhatsAppAttachment {
  const candidate = value as WhatsAppAttachment;
  return typeof candidate.kind === "string" && typeof candidate.message_row_id === "string";
}

function inboxAttachments(message: WhatsAppMessage): WhatsAppAttachment[] {
  return (message.attachments ?? []).filter(isInboxAttachment);
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

export function WhatsAppMessageBubble({
  message,
  isSent,
  connectionMode = null,
  onForward,
  onPin,
  onUnpin,
  onHide,
  onRevoke,
}: WhatsAppMessageBubbleProps): JSX.Element {
  const hasSpecialInline = message.message && (
    message.message.startsWith("[Location]")
    || message.message.startsWith("[Contact]")
    || message.message.startsWith("[Reaction]")
  );
  const attachments = inboxAttachments(message);
  const understanding = message.media_understanding?.trim();
  const revoked = Boolean(message.revoked_at);

  const body = (
    <div className={cn("flex max-w-[75%] flex-col", isSent ? "ml-auto items-end" : "items-start")}>
      <span className="mb-1 text-xs text-muted-foreground">{message.from?.name}</span>
      <div
        className={cn(
          "relative rounded-2xl px-4 py-2 text-sm",
          isSent
            ? "rounded-br-sm bg-whatsapp/20 text-foreground dark:bg-whatsapp-dark/40"
            : "rounded-bl-sm bg-card text-foreground shadow-sm",
        )}
      >
        {revoked ? (
          <p className="italic opacity-80">This message was deleted</p>
        ) : hasSpecialInline ? (
          <InlineMediaFromText text={message.message} />
        ) : message.message ? (
          <p className="whitespace-pre-wrap">{message.message}</p>
        ) : null}
        {revoked ? null : attachments.map((attachment) => (
          <WhatsAppMediaAttachment
            key={attachment.message_row_id}
            attachment={attachment}
            createdTime={message.created_time}
          />
        ))}
      </div>
      {!revoked && understanding ? (
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
      <span className="mt-0.5 inline-flex items-center gap-1 text-[10px] text-muted-foreground">
        <span>{formatBubbleTime(message.created_time)}</span>
        {isSent ? <WhatsAppStatusTicks status={message.status} /> : null}
      </span>
    </div>
  );

  if (revoked) {
    return (
      <div data-testid="wa-bubble" data-message-id={message.id}>
        {body}
      </div>
    );
  }

  return (
    <WhatsAppMessageContextMenu
      message={message}
      connectionMode={connectionMode}
      onCopy={() => {
        void navigator.clipboard.writeText(message.message ?? "");
      }}
      onForward={() => onForward?.()}
      onPin={() => onPin?.()}
      onUnpin={() => onUnpin?.()}
      onHide={() => onHide?.()}
      onRevoke={() => onRevoke?.()}
    >
      {body}
    </WhatsAppMessageContextMenu>
  );
}
