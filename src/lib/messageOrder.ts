/**
 * Orders inbox messages oldest -> newest, so the newest bubble lands at the bottom
 * of the pane where ConversationDetail's auto-scroll anchor sits.
 *
 * The two message sources disagree on order. Graph `get_messages`
 * (facebook/instagram) returns newest-first, so reversing is exact and cheap.
 * WhatsApp rows come from our own `whatsapp_messages` table through
 * `whatsapp_get_messages`, which returns newest-first for the row limit but is
 * fed by two ingest paths (Cloud webhook and Evolution QR) that can persist the
 * same second out of insertion order. That side is therefore sorted on the
 * timestamp itself rather than on the array order, which also keeps the pane
 * correct if it is ever served by an edge function older than this build.
 */
export function sortMessagesForDisplay<T extends { created_time: string }>(
  messages: readonly T[],
  platform?: string,
): T[] {
  if (platform !== "whatsapp") return [...messages].reverse();
  return [...messages].sort(
    (a, b) => new Date(a.created_time).getTime() - new Date(b.created_time).getTime(),
  );
}
