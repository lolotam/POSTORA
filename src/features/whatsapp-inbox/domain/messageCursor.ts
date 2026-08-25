import { sortMessagesForDisplay } from "@/lib/messageOrder";

export interface MessageCursor {
  timestamp: string;
  id: string;
}

export interface CursorMessage {
  id: string;
  created_time: string;
  message?: string;
  revoked_at?: string | null;
  revoked_by?: string | null;
  status?: string | null;
  media_understanding?: string | null;
}

const STATUS_RANK: Record<string, number> = {
  pending: 0,
  queued: 0,
  sent: 1,
  delivered: 2,
  read: 3,
  played: 3,
  failed: 2,
  error: 2,
};

export function oldestMessageCursor(messages: readonly CursorMessage[]): MessageCursor | undefined {
  const oldest = sortMessagesForDisplay(messages, "whatsapp")[0];
  if (!oldest?.id || !oldest.created_time) return undefined;
  return { timestamp: oldest.created_time, id: oldest.id };
}

export function mergeMessageRecord<T extends CursorMessage>(existing: T, incoming: T): T {
  const incomingStatus = incoming.status ?? null;
  const existingStatus = existing.status ?? null;
  const incomingRank = incomingStatus ? (STATUS_RANK[incomingStatus] ?? 1) : -1;
  const existingRank = existingStatus ? (STATUS_RANK[existingStatus] ?? 1) : -1;
  return {
    ...incoming,
    revoked_at: incoming.revoked_at ?? existing.revoked_at ?? null,
    revoked_by: incoming.revoked_by ?? existing.revoked_by ?? null,
    media_understanding: incoming.media_understanding ?? existing.media_understanding ?? null,
    status: incomingRank >= existingRank ? incomingStatus : existingStatus,
  };
}

export function mergeMessagesIntoStore<T extends CursorMessage>(
  store: Map<string, T>,
  incoming: readonly T[],
): boolean {
  let changed = false;
  for (const message of incoming) {
    const existing = store.get(message.id);
    if (!existing) {
      store.set(message.id, message);
      changed = true;
      continue;
    }
    const merged = mergeMessageRecord(existing, message);
    if (!sameMutableMessage(existing, merged)) {
      store.set(message.id, merged);
      changed = true;
    }
  }
  return changed;
}

export function mergeMessagePages<T extends CursorMessage>(
  latest: readonly T[],
  historyPages: readonly (readonly T[])[],
): T[] {
  const store = new Map<string, T>();
  mergeMessagesIntoStore(store, latest);
  for (const page of historyPages) mergeMessagesIntoStore(store, page);
  return sortMessagesForDisplay([...store.values()], "whatsapp");
}

function sameMutableMessage(left: CursorMessage, right: CursorMessage): boolean {
  return left.message === right.message
    && left.created_time === right.created_time
    && left.revoked_at === right.revoked_at
    && left.revoked_by === right.revoked_by
    && left.status === right.status
    && left.media_understanding === right.media_understanding;
}
