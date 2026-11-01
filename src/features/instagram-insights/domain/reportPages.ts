import type { OwnerReport, OwnerReportMediaItem } from "./types";

/** Keep the server's ordering while excluding overlaps between fetched pages. */
export function collectReportMedia(pages: readonly OwnerReport[]): OwnerReportMediaItem[] {
  const seen = new Set<string>();
  const items: OwnerReportMediaItem[] = [];
  for (const page of pages) {
    for (const item of page.media.page.items) {
      if (seen.has(item.mediaId)) continue;
      seen.add(item.mediaId);
      items.push(item);
    }
  }
  return items;
}
