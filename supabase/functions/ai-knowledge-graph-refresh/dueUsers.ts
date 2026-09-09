/**
 * Deciding which users' knowledge-graph exports the nightly worker rebuilds.
 *
 * A published export is a snapshot of the entity and relation tables at the
 * moment it was written, so "is it stale" is a question about data, not about a
 * queue. Keeping it a pure function over rows means all four conditions are
 * testable without a live database, and means a run that dies halfway loses
 * nothing: tomorrow's run re-derives the same answer.
 */

import { parseExportUrlTarget } from "../_shared/knowledgeExportUrls.ts";
import { KNOWLEDGE_BUCKET } from "../_shared/knowledgeSourceFiles.ts";

/** What a user's graph looks like right now. */
export interface GraphActivity {
  userId: string;
  entityCount: number;
  relationCount: number;
  /** Newest of the user's entity and relation timestamps, ISO-8601, or null. */
  newestActivity: string | null;
}

/** What was published for that user last time, if anything. */
export interface PublishedExport {
  htmlUrl: string | null;
  vaultUrl: string | null;
  generatedAt: string | null;
  entityCount: number | null;
  relationCount: number | null;
}

export type RefreshReason =
  /** Graph has content but nothing was ever published for this user. */
  | "never_exported"
  /**
   * The published URL points at Supabase Storage rather than an external
   * delivery host. Storage serves graph.html as text/plain whatever mimetype it
   * was stored with, so such an export can only ever show source code in a
   * browser. Rebuilding sends it to Openinary. This is also the backfill for
   * rows written before Openinary was configured.
   */
  | "unrenderable_host"
  /**
   * Counts moved. This is the only condition that sees a deletion: removing an
   * entity moves no created_at, and the nightly prune at 03:15 deletes orphan
   * entities, so without it a pruned user would stay stale forever with no
   * timestamp to prove it. A null stored count means the row predates the
   * columns and refreshes once.
   */
  | "count_changed"
  /** Something was indexed since the export was written. */
  | "new_activity";

/**
 * Returns why this user is due, or null if their published export is current.
 *
 * Reasons are ordered by how badly the published export misrepresents reality,
 * not by how the check is cheapest to run: an unviewable link is worse than an
 * out-of-date one. Only the first matching reason is reported, and it is used
 * for logging only -- every reason produces the same rebuild.
 */
export function refreshReasonFor(
  activity: GraphActivity,
  published: PublishedExport | null,
): RefreshReason | null {
  if (!published || !published.generatedAt) {
    // A user with no entities has nothing to publish. Without this they would
    // be reported as due on every run for the rest of the system's life.
    return activity.entityCount > 0 ? "never_exported" : null;
  }

  if (!isRenderableHost(published.htmlUrl) || !isRenderableHost(published.vaultUrl)) {
    return "unrenderable_host";
  }

  if (
    published.entityCount !== activity.entityCount ||
    published.relationCount !== activity.relationCount
  ) {
    return "count_changed";
  }

  if (isAfter(activity.newestActivity, published.generatedAt)) {
    return "new_activity";
  }

  return null;
}

/** Any Supabase Storage object URL, whatever bucket it names. */
const STORAGE_OBJECT_PATH = "/storage/v1/object/";

/**
 * True when the stored value is an external delivery URL (Openinary or
 * Cloudinary), which is served with its real content type. A storage reference,
 * a legacy public-storage URL, and an absent value are all not renderable --
 * absent included, because a row that published only half its exports still owes
 * the other half.
 *
 * The bucket-aware parse is not enough on its own. It maps a storage URL back to
 * a path only for the *expected* bucket and calls anything else external, but
 * these columns are user-writable via RLS and Supabase Storage down-converts
 * HTML on every bucket. So a storage host is disqualified by its path, and the
 * parse then separates a durable `supabase://` reference from a real delivery
 * URL.
 */
function isRenderableHost(stored: string | null): boolean {
  if (!stored) return false;
  if (stored.includes(STORAGE_OBJECT_PATH)) return false;
  return parseExportUrlTarget(stored, KNOWLEDGE_BUCKET)?.kind === "external";
}

/**
 * Timestamp comparison that refuses to guess. An unparseable or absent value on
 * either side answers false, so a corrupted timestamp leaves the export alone
 * rather than rebuilding it on every run forever.
 */
function isAfter(candidate: string | null, reference: string): boolean {
  if (!candidate) return false;
  const later = Date.parse(candidate);
  const earlier = Date.parse(reference);
  if (Number.isNaN(later) || Number.isNaN(earlier)) return false;
  return later > earlier;
}
