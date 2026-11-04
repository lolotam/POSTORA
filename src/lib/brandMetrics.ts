import type { BrandPost, BrandScrapeFilters, MediaType } from "@/types/brand-intelligence";

type BrandMetric = "engagementScore" | "likesCount" | "commentsCount" | "videoViewCount" | "sharesCount" | "savesCount";

export function formatBrandMetric(value: number | null | undefined): string {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "—";
}

/** Unknown values follow measured zero; stable IDs make equal-score pages deterministic. */
export function compareBrandMetric(a: BrandPost, b: BrandPost, metric: BrandMetric): number {
  const left = a[metric];
  const right = b[metric];
  const leftKnown = typeof left === "number" && Number.isFinite(left);
  const rightKnown = typeof right === "number" && Number.isFinite(right);
  if (leftKnown !== rightKnown) return leftKnown ? -1 : 1;
  return (leftKnown && rightKnown ? right - left : 0) || a.id.localeCompare(b.id);
}

// Instagram returns a Reel as REEL and a multi-item post as CAROUSEL, so a
// filter that matched only the literal VIDEO or IMAGE hid most of the feed.
const MEDIA_TYPES_FOR_FILTER: Record<Exclude<BrandScrapeFilters["mediaType"], "all">, readonly MediaType[]> = {
  image: ["IMAGE", "CAROUSEL"],
  video: ["VIDEO", "REEL"],
  reel: ["REEL"],
  carousel: ["CAROUSEL"],
};

export function matchesMediaTypeFilter(post: BrandPost, filter: BrandScrapeFilters["mediaType"]): boolean {
  return filter === "all" || MEDIA_TYPES_FOR_FILTER[filter].includes(post.mediaType);
}
