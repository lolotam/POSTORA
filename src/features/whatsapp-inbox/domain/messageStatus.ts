export type TickKind = "sent" | "delivered" | "read" | "failed";

/** whatsapp_messages.status → tick. Inbound rows carry "received" and never render ticks. */
export function tickKindFor(status: string | null | undefined): TickKind {
  if (status === "delivered" || status === "read" || status === "failed") return status;
  return "sent";
}

export function formatBubbleTime(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}
