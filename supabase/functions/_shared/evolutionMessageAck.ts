// WhatsApp's verdict on a send arrives after Evolution's 201, as a server ack on the same
// key via MESSAGES_UPDATE. Without it every outbound row stays "sent" forever and a
// rejected message (Baileys 463 on a cold contact) is invisible.

export type AckStatus = "ERROR" | "PENDING" | "SERVER_ACK" | "DELIVERY_ACK" | "READ" | "PLAYED";

/** Baileys' numeric WAMessageStatus in enum order; Evolution maps through it. */
const ACK_BY_NUMBER: readonly AckStatus[] = [
  "ERROR",
  "PENDING",
  "SERVER_ACK",
  "DELIVERY_ACK",
  "READ",
  "PLAYED",
];

export type InboxAckStatus = "delivered" | "read" | "failed";

export function normalizeAckStatus(value: unknown): AckStatus | null {
  if (typeof value === "number") return ACK_BY_NUMBER[value] ?? null;
  if (typeof value !== "string") return null;
  const upper = value.trim().toUpperCase();
  return (ACK_BY_NUMBER as readonly string[]).includes(upper) ? (upper as AckStatus) : null;
}

export function inboxStatusForAck(status: AckStatus): InboxAckStatus | null {
  switch (status) {
    case "ERROR":
      return "failed";
    case "DELIVERY_ACK":
      return "delivered";
    case "READ":
    case "PLAYED":
      return "read";
    default:
      return null;
  }
}

/** Message-key ids are alphanumeric from Baileys; anything else is not ours to look up. */
export function isMessageKeyId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9]{8,64}$/.test(value);
}

export const MESSAGE_STATUS_RANK: Record<string, number> = { sent: 1, delivered: 2, read: 3, failed: 4 };

/** Acks can arrive out of order; a late DELIVERY_ACK must not undo READ. Failed is terminal. */
export function shouldAdvanceStatus(current: string | null, next: InboxAckStatus): boolean {
  if (current === "failed") return false;
  const currentRank = current ? MESSAGE_STATUS_RANK[current] ?? 0 : 0;
  return MESSAGE_STATUS_RANK[next] > currentRank;
}

export interface AckUpdate {
  messageId: string;
  status: InboxAckStatus;
}

/**
 * Evolution 2.3.7 sends `{ keyId, remoteJid, fromMe, status }`; the raw Baileys shape
 * `{ key: { id, fromMe }, update: { status } }` is accepted too so a gateway upgrade cannot
 * silently stop acks. Only our own sends matter: a contact's read receipt on an inbound
 * message is not a delivery outcome.
 */
export function ackUpdates(items: unknown[]): AckUpdate[] {
  const updates: AckUpdate[] = [];
  for (const raw of items) {
    const item = (raw ?? {}) as Record<string, any>;
    const key = item.key ?? {};
    const keyId = item.keyId ?? key.id;
    const fromMe = item.fromMe ?? key.fromMe;
    const ack = normalizeAckStatus(item.status ?? item.update?.status);
    if (!isMessageKeyId(keyId) || fromMe !== true || !ack) continue;
    const status = inboxStatusForAck(ack);
    if (status) updates.push({ messageId: keyId, status });
  }
  return updates;
}
