export const LEGACY_MESSAGE_LIMIT = 100;
export const PAGINATED_DEFAULT_LIMIT = 40;
export const PAGINATED_MAX_LIMIT = 100;

export class MalformedMessageCursorError extends Error {
  constructor(message = "Malformed message cursor") {
    super(message);
    this.name = "MalformedMessageCursorError";
  }
}

export interface MessageCursor {
  timestamp: string;
  id: string;
}

export type WhatsAppMessagePageRequest =
  | { mode: "legacy" }
  | { mode: "paginated"; limit: number; before?: MessageCursor };

export interface WhatsAppMessagePageInfo {
  next_before: MessageCursor | null;
  has_more: boolean;
}

const FILTER_UNSAFE = /[,()]/;

export function clampLimit(value: unknown): number {
  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return PAGINATED_DEFAULT_LIMIT;
  return Math.min(Math.floor(numeric), PAGINATED_MAX_LIMIT);
}

export function parseMessageCursor(value: unknown): MessageCursor {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new MalformedMessageCursorError();
  }
  const record = value as Record<string, unknown>;
  const timestamp = record.timestamp;
  const id = record.id;
  if (typeof timestamp !== "string" || typeof id !== "string") {
    throw new MalformedMessageCursorError();
  }
  if (timestamp.length === 0 || id.length === 0) {
    throw new MalformedMessageCursorError();
  }
  if (Number.isNaN(Date.parse(timestamp))) {
    throw new MalformedMessageCursorError();
  }
  // Interpolated into a PostgREST `or` filter; commas and parens would change the predicate
  // rather than fail, which is how a malformed cursor would silently become page one.
  if (FILTER_UNSAFE.test(timestamp) || FILTER_UNSAFE.test(id)) {
    throw new MalformedMessageCursorError();
  }
  return { timestamp, id };
}

export function parseWhatsAppMessagePageRequest(
  body: Record<string, unknown>,
): WhatsAppMessagePageRequest {
  const paginated = Object.prototype.hasOwnProperty.call(body, "limit")
    || Object.prototype.hasOwnProperty.call(body, "before");
  if (!paginated) return { mode: "legacy" };

  const before = Object.prototype.hasOwnProperty.call(body, "before") && body.before != null
    ? parseMessageCursor(body.before)
    : undefined;
  return { mode: "paginated", limit: clampLimit(body.limit), before };
}

export function conversationIdsForFilter(
  normalizedConvId: string,
  conversationId: string,
): string[] {
  if (normalizedConvId === conversationId) return [conversationId];
  return [normalizedConvId, conversationId];
}

export function keysetOrFilter(cursor: MessageCursor): string {
  return `timestamp.lt.${cursor.timestamp},and(timestamp.eq.${cursor.timestamp},id.lt.${cursor.id})`;
}

export function pageFetchLimit(request: WhatsAppMessagePageRequest): number {
  if (request.mode === "legacy") return LEGACY_MESSAGE_LIMIT;
  return request.limit + 1;
}

export function sliceWhatsAppMessagePage<T extends { id: string; timestamp?: string | null }>(
  rows: T[],
  request: WhatsAppMessagePageRequest,
): { rows: T[]; page_info?: WhatsAppMessagePageInfo } {
  if (request.mode === "legacy") return { rows };

  const hasMore = rows.length > request.limit;
  const trimmed = hasMore ? rows.slice(0, request.limit) : rows;
  const oldest = trimmed[trimmed.length - 1];
  const nextBefore = hasMore && oldest?.timestamp
    ? { timestamp: oldest.timestamp, id: oldest.id }
    : null;
  return {
    rows: trimmed,
    page_info: { next_before: nextBefore, has_more: hasMore },
  };
}
