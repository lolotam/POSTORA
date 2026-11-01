import { isAnalyticsMetricMeasurable } from "../../../../supabase/functions/_shared/analyticsContract.ts";
import type { AnalyticsReport } from "./types";

/** Continuation is a read boundary; collection gaps survive loading every page. */
export function mergeSavedAnalyticsPages(pages: readonly AnalyticsReport[]): AnalyticsReport | null {
  const first = pages[0];
  if (!first) return null;
  const last = pages[pages.length - 1];
  const items = Array.from(new Map(pages.flatMap((page) => page.posts.items).map((post) => [post.id, post])).values());
  const reason = pages.find((page) => page.posts.reason !== null)?.posts.reason ?? null;
  const truncated = last.posts.nextCursor !== null || last.truncated || reason !== null;
  const incompleteCells = items.some((post) => post.metrics.some((metric) => isAnalyticsMetricMeasurable(metric.definition) && metric.current.status !== "available"));
  const partialSync = pages.some((page) => page.sync.status === "partial") && ["fresh", "stale"].includes(first.sync.status);
  return { ...first, truncated,
    posts: { items, nextCursor: last.posts.nextCursor, truncated, reason, status: truncated || incompleteCells ? "partial" : "available" },
    sync: partialSync ? { ...first.sync, status: "partial", reason: null } : first.sync };
}
