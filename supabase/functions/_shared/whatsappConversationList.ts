// Pure helpers for messaging-api `whatsapp_list_conversations`.
//
// The list used to return 50 rows and the client searched by name only; a 285-chat
// account showed 50 and could not find a chat by number. Search is server-side now and
// the cap is the largest a workspace has been seen to hold, times two.

export const CONVERSATION_LIST_LIMIT = 500;
const SEARCH_MAX_CHARS = 80;

/** Strips ilike wildcards and PostgREST filter separators; null when nothing is left. */
export function sanitizeConversationSearch(q: unknown): string | null {
  if (typeof q !== "string") return null;
  const term = q.replace(/[%_(),]/g, "").trim().slice(0, SEARCH_MAX_CHARS);
  return term.length > 0 ? term : null;
}

/** PostgREST `or` predicate: name or the phone digits carried by the conversation id. */
export function conversationSearchOr(term: string): string {
  return `participant_name.ilike.%${term}%,conversation_id.ilike.%${term}%`;
}

function isBarePhone(name: string, phone: string): boolean {
  return name.replace(/^\+/, "") === phone;
}

/**
 * The contact directory is the authoritative name book: a name the user typed there beats
 * the push name captured at ingest. A directory row whose display_name is just the number
 * (auto-captured on outbound sends) carries no information and yields to the push name.
 */
export function displayNameFor(
  cachedName: string | null,
  phone: string,
  contact: { display_name: string | null } | undefined,
): string {
  const directory = contact?.display_name?.trim();
  if (directory && !isBarePhone(directory, phone)) return directory;
  const cached = cachedName?.trim();
  if (cached) return cached;
  return `+${phone}`;
}
