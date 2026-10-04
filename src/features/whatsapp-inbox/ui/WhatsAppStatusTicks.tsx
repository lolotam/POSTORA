import { AlertCircle, Check, CheckCheck } from "lucide-react";
import { tickKindFor } from "../domain/messageStatus";

export function WhatsAppStatusTicks({ status }: { status: string | null | undefined }): JSX.Element {
  const kind = tickKindFor(status);
  const icon = kind === "failed"
    ? <AlertCircle className="h-3.5 w-3.5 text-destructive" />
    : kind === "read"
      ? <CheckCheck className="h-3.5 w-3.5 text-foreground" />
      : kind === "delivered"
        ? <CheckCheck className="h-3.5 w-3.5 opacity-60" />
        : <Check className="h-3.5 w-3.5 opacity-60" />;
  return (
    <span data-testid="wa-ticks" data-status={kind} aria-label={`Message ${kind}`} className="inline-flex">
      {icon}
    </span>
  );
}
