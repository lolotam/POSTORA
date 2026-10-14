import { draftStatus, type StatusView } from "./approvals";
import type { PublishStatus, ReviewDraft } from "./types";

export type ActivityFilter = "all" | "pending" | "scheduled" | "published" | "failed" | "rejected" | "archived";

export interface PipelineItem {
  draft: ReviewDraft;
  status: StatusView;
  filter: Exclude<ActivityFilter, "all">;
  /** When the post publishes (scheduled time) or was last touched; drives Calendar placement. */
  when: string;
  scheduledAt: string | null;
  failureReason: string | null;
  postUrl: string | null;
  /** The database's reopen rule for this attempt ("Back to pending"). */
  reopenable: boolean;
}

export function toPipelineItem(draft: ReviewDraft, publish: PublishStatus | null): PipelineItem {
  const status = draftStatus(draft.state, draft.state === "submitted" ? publish?.state ?? null : null);
  const scheduledAt = draft.submission?.scheduledAt ?? null;
  return {
    draft,
    status,
    filter: filterOf(draft, publish),
    when: scheduledAt ?? draft.updatedAt,
    scheduledAt,
    failureReason: publish && (publish.state === "failed" || publish.state === "needs_attention") ? publish.reason : null,
    postUrl: publish?.state === "published" ? publish.postUrl : null,
    reopenable: draft.state === "submitted" && publish?.reopenable === true,
  };
}

function filterOf(draft: ReviewDraft, publish: PublishStatus | null): Exclude<ActivityFilter, "all"> {
  switch (draft.state) {
    case "pending_review":
      return "pending";
    case "rejected":
      return "rejected";
    case "archived":
      return "archived";
    case "submitted":
      if (publish?.state === "published") return "published";
      if (publish?.state === "failed" || publish?.state === "needs_attention") return "failed";
      return "scheduled";
    default: {
      const unreachable: never = draft.state;
      return unreachable;
    }
  }
}

export const ACTIVITY_FILTER_LABELS: Record<ActivityFilter, string> = {
  all: "All",
  pending: "Pending",
  scheduled: "Approved",
  published: "Published",
  failed: "Publish failed",
  rejected: "Rejected",
  archived: "Archived",
};

export function countByFilter(items: readonly PipelineItem[]): Record<ActivityFilter, number> {
  const counts: Record<ActivityFilter, number> = {
    all: items.length, pending: 0, scheduled: 0, published: 0, failed: 0, rejected: 0, archived: 0,
  };
  for (const item of items) counts[item.filter] += 1;
  return counts;
}

export type ActivityGroup = "Today" | "This week" | "Earlier";

/** Activity groups by last change: today, the previous 6 days, then everything older. */
export function activityGroup(updatedAt: string, now: Date): ActivityGroup {
  const at = new Date(updatedAt);
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  if (at >= startOfToday) return "Today";
  const weekAgo = new Date(startOfToday);
  weekAgo.setDate(weekAgo.getDate() - 6);
  return at >= weekAgo ? "This week" : "Earlier";
}
