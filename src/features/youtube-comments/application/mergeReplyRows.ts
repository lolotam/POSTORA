import type { Stage4CommentRow } from "../domain/types";

/** A comment row together with when the read that produced it finished. */
export interface StampedRow {
  row: Stage4CommentRow;
  /** `dataUpdatedAt` of the query page the row came from (milliseconds). */
  readAt: number;
}

/**
 * Merge the inline reply preview of a thread page with the rows of the reply
 * pages, by comment id. For one comment id the row from the LATER successful
 * read wins (text, moderation status and handle together); on a tie the reply
 * page wins, because it is the read made for the replies themselves. A row that
 * exists on one side only is kept. The order is the reply pages' order, then
 * the inline rows that no reply page carries.
 */
export function mergeReplyRows(inline: StampedRow[], paged: StampedRow[]): Stage4CommentRow[] {
  const merged = new Map<string, StampedRow>();
  for (const item of paged) merged.set(item.row.comment_id, item);
  for (const item of inline) {
    const existing = merged.get(item.row.comment_id);
    if (!existing || item.readAt > existing.readAt) merged.set(item.row.comment_id, item);
  }
  return [...merged.values()].map((item) => item.row);
}
