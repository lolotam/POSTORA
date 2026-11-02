import { z } from "https://esm.sh/zod@3.25.76";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import { OwnedAnalyticsStore, type OwnedAnalyticsPlatform } from "./store.ts";

export type RetentionCounts = { targeted: number; visited: number; deleted: number; wouldDelete: number; skipped: number; refused: number };
export const retentionContinuation = z.object({ afterAccountId: z.string().uuid(), scopeDigest: z.string().regex(/^[a-f0-9]{64}$/),
  floor: z.string().regex(/^\d{4}-\d{2}-\d{2}T00:00:00\.000Z$/) }).strict();
export type RetentionContinuation = z.infer<typeof retentionContinuation>;
type RetentionInput = { platform: OwnedAnalyticsPlatform | "all"; dryRun: boolean; continuation?: RetentionContinuation;
  store: OwnedAnalyticsStore; deadline: AnalyticsWorkerDeadline };
export type RetentionResult = { status: "complete" | "partial" | "disabled" | "unavailable"; counts: RetentionCounts; reason: string | null;
  floor: string; continuation?: RetentionContinuation | null };

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
    if (disabled === platforms.length) return { status: "disabled", counts, reason: null, floor: floor.toISOString() };
    targets.sort((left, right) => (input.dryRun ? 0 : left.visitedAt - right.visitedAt) || left.accountId.localeCompare(right.accountId));
    let scopeDigest = "";
    if (input.dryRun) {
      if (input.continuation) {
        const pinnedFloor = Date.parse(input.continuation.floor);
        if (!Number.isFinite(pinnedFloor) || pinnedFloor > floor.getTime() || pinnedFloor < floor.getTime() - 86_400_000) {
          throw new AnalyticsWorkerStopped("invalid_contract");
        }
        floor.setTime(pinnedFloor);
      }
      const scope = JSON.stringify([input.platform, floor.toISOString(), targets.map((target) => [target.platform, target.accountId])]);
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(scope));
      scopeDigest = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
      if (input.continuation) {
        const after = targets.findIndex((target) => target.accountId === input.continuation!.afterAccountId);
        if (scopeDigest !== input.continuation.scopeDigest || after < 0) throw new AnalyticsWorkerStopped("invalid_contract");
        targets.splice(0, after + 1);
      }
    }
    counts.targeted = targets.length;
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
    const next = input.dryRun && counts.visited > 0 && counts.visited < targets.length ? {
      afterAccountId: targets[counts.visited - 1].accountId, scopeDigest, floor: floor.toISOString(),
    } : null;
    return { status: counts.visited === targets.length && counts.deleted + counts.wouldDelete < 500 && !counts.refused && !counts.skipped ? "complete" : "partial",
      counts, reason: null, floor: floor.toISOString(), ...(input.dryRun ? { continuation: next } : {}) };
  } catch (error) {
    return { status: "unavailable", counts, reason: error instanceof AnalyticsWorkerStopped ? error.reason : "storage_unavailable", floor: floor.toISOString() };
  }
}
