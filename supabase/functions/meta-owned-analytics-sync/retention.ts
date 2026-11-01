import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import { OwnedAnalyticsStore, type OwnedAnalyticsPlatform } from "./store.ts";

export type RetentionCounts = { targeted: number; visited: number; deleted: number; wouldDelete: number; skipped: number; refused: number };
type RetentionInput = { platform: OwnedAnalyticsPlatform | "all"; dryRun: boolean; store: OwnedAnalyticsStore; deadline: AnalyticsWorkerDeadline };
export type RetentionResult = { status: "complete" | "partial" | "disabled" | "unavailable"; counts: RetentionCounts; reason: string | null; floor: string };

/** Target visits and physical child counts are shared across the complete action. */
export async function retainOwnedAnalytics(input: RetentionInput): Promise<RetentionResult> {
  const counts: RetentionCounts = { targeted: 0, visited: 0, deleted: 0, wouldDelete: 0, skipped: 0, refused: 0 };
  const floor = new Date(input.deadline.startedAt);
  floor.setUTCHours(0, 0, 0, 0);
  floor.setUTCDate(floor.getUTCDate() - 365);
  const targets: { platform: OwnedAnalyticsPlatform; accountId: string; visitedAt: number }[] = [];
  let disabled = 0;
  try {
    const platforms = input.platform === "all" ? ["facebook", "threads"] as const : [input.platform];
    for (const platform of platforms) {
      const listed = await input.store.retentionTargets(platform, input.dryRun);
      if (listed.state === "disabled") { disabled++; continue; }
      for (const target of listed.targets) targets.push({ platform, accountId: target.account_id,
        visitedAt: target.last_visited_at ? Date.parse(target.last_visited_at) : -Infinity });
    }
    counts.targeted = targets.length;
    if (disabled === platforms.length) return { status: "disabled", counts, reason: null, floor: floor.toISOString() };
    targets.sort((left, right) => left.visitedAt - right.visitedAt || left.accountId.localeCompare(right.accountId));
    for (const target of targets) {
      const remaining = 500 - counts.deleted - counts.wouldDelete;
      if (counts.visited >= 50 || remaining <= 0 || input.deadline.remainingMs < 10_000) break;
      counts.visited++;
      try {
        const receipt = await input.store.cleanup({ platform: target.platform, accountId: target.accountId,
          floor: floor.toISOString(), limit: remaining, dryRun: input.dryRun });
        counts[input.dryRun ? "wouldDelete" : "deleted"] += receipt.deleted;
        if (receipt.skipped) counts.skipped++;
      } catch (error) {
        if (!(error instanceof AnalyticsWorkerStopped) || !["MAH02", "MAH03", "MAH04"].includes(error.sqlstate ?? "")) throw error;
        counts.refused++;
      }
    }
    return { status: counts.visited === targets.length && counts.deleted + counts.wouldDelete < 500 && !counts.refused && !counts.skipped ? "complete" : "partial", counts, reason: null, floor: floor.toISOString() };
  } catch (error) {
    return { status: "unavailable", counts, reason: error instanceof AnalyticsWorkerStopped ? error.reason : "storage_unavailable", floor: floor.toISOString() };
  }
}
