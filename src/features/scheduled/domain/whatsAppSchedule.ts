export const ACTIVE_WHATSAPP_STATUSES = ["pending", "claimed", "sending"] as const;

export const CALENDAR_WHATSAPP_STATUSES = ["pending", "claimed", "sending", "sent", "failed", "skipped"] as const;

export const WHATSAPP_RANGE_LIMIT = 1000;

const TERMINAL_WHATSAPP_STATUSES = new Set(["sent", "failed", "skipped"]);

export type WhatsAppScheduleAction = "editable" | "sending" | "locked";

export function whatsAppScheduleAction(status: string): WhatsAppScheduleAction {
  if (status === "pending") return "editable";
  if (status === "claimed" || status === "sending") return "sending";
  return "locked";
}

export function whatsAppChipIsDraggable(status: string): boolean {
  return status === "pending";
}

export function whatsAppChipIsMuted(status: string): boolean {
  return TERMINAL_WHATSAPP_STATUSES.has(status);
}

export function isActiveWhatsAppStatus(status: string): boolean {
  return (ACTIVE_WHATSAPP_STATUSES as readonly string[]).includes(status);
}

export function isCalendarWhatsAppStatus(status: string): boolean {
  return (CALENDAR_WHATSAPP_STATUSES as readonly string[]).includes(status);
}
