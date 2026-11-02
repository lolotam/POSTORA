import { admitOwnedAnalyticsAccount, type AdmissionResult } from "./admission.ts";
import { AnalyticsWorkerDeadline, AnalyticsWorkerStopped } from "./deadline.ts";
import { AdmissionProviderUnavailable, type AdmissionApp } from "./permissionProvider.ts";
import { OwnedAnalyticsStore, type OwnedAnalyticsPlatform } from "./store.ts";

export type DispatchCounts = { visited: number; queued: number; refused: number };
export type DispatchResult = { status: "complete" | "partial" | "disabled" | "unavailable"; counts: DispatchCounts; reason: string | null };
type DispatchInput = { platform: OwnedAnalyticsPlatform | "all"; store: OwnedAnalyticsStore; deadline: AnalyticsWorkerDeadline;
  app: (platform: OwnedAnalyticsPlatform) => AdmissionApp | null; fetch?: typeof fetch };

function isTargetRefusal(error: unknown): error is AnalyticsWorkerStopped {
  return error instanceof AnalyticsWorkerStopped && error.reason === "admission_refused"
    && ["MAH02", "MAH03", "MAH04"].includes(error.sqlstate ?? "");
}

/** Ranking is only a hint; actual tickets and commits repeat current SQL checks. */
async function dispatchOrder(input: DispatchInput): Promise<{ platforms: OwnedAnalyticsPlatform[]; disabled: number; completed: number; refused: boolean }> {
  if (input.platform !== "all") return { platforms: [input.platform], disabled: 0, completed: 0, refused: false };
  const hints: { platform: OwnedAnalyticsPlatform; round: number; servedAt: number; complete: boolean; refused: boolean }[] = [];
  let disabled = 0;
  for (const platform of ["facebook", "threads"] as const) {
    const next = await input.store.nextDispatch(platform, false);
    if (next.state === "disabled") { disabled++; continue; }
    const round = next.state === "target" ? next.ticket.round : next.state === "complete" ? next.round + 1 : 1;
    hints.push({ platform, round, servedAt: next.state === "not_started" ? -Infinity : Date.parse(next.served_at),
      complete: next.state === "complete", refused: next.state === "complete" && next.refused_count > 0 });
  }
  hints.sort((left, right) => left.round - right.round || left.servedAt - right.servedAt || left.platform.localeCompare(right.platform));
  // Reopening a finished round must wait until its peer finishes the current one.
  // Once all enabled platforms finish, a later invocation may start a new round.
  const skipped = hints.some((hint) => !hint.complete) ? hints.filter((hint) => hint.complete) : [];
  return { platforms: hints.filter((hint) => !skipped.includes(hint)).map((hint) => hint.platform), disabled,
    completed: skipped.length, refused: skipped.some((hint) => hint.refused) };
}

/** A completed enumeration is not a completed measurement job. */
export async function dispatchOwnedAnalyticsDaily(input: DispatchInput): Promise<DispatchResult> {
  const counts: DispatchCounts = { visited: 0, queued: 0, refused: 0 };
  try {
    const ordered = await dispatchOrder(input);
    let completed = ordered.disabled + ordered.completed;
    let disabled = ordered.disabled;
    let refusedEarlier = ordered.refused;
    for (const platform of ordered.platforms) {
      let start = true;
      while (counts.visited < 50 && input.deadline.remainingMs >= 15_000) {
        const next = await input.store.nextDispatch(platform, start);
        start = false;
        if (next.state === "disabled") { completed++; disabled++; break; }
        if (next.state === "complete") { completed++; refusedEarlier ||= next.refused_count > 0; break; }
        if (next.state === "not_started") return { status: "partial", counts, reason: "dispatch_changed" };
        counts.visited++;
        let receipt = await input.store.commitDispatch(next.ticket, "enqueue");
        if (receipt.state === "needs_admission") {
          const app = input.app(platform);
          if (!app) throw new AnalyticsWorkerStopped("configuration_unavailable");
          let admitted: AdmissionResult;
          try {
            admitted = await admitOwnedAnalyticsAccount({ platform, accountId: next.ticket.account_id, app,
              store: input.store, deadline: input.deadline, fetch: input.fetch });
          } catch (error) {
            if (error instanceof AdmissionProviderUnavailable) {
              const failed = await input.store.recordAdmissionFailure(next.ticket, error.reason, crypto.randomUUID());
              if (failed.state === "advanced") {
                counts[failed.outcome]++;
                refusedEarlier ||= failed.refused_count > 0;
                if (failed.outcome === "refused") return { status: "partial", counts, reason: "admission_unavailable" };
                if (failed.complete) { completed++; break; }
                continue;
              }
              throw error;
            }
            if (!isTargetRefusal(error)) throw error;
            if (error.sqlstate === "MAH04") return { status: "partial", counts, reason: "dispatch_changed" };
            admitted = { status: "refused", reason: "admission_refused" };
          }
          if (admitted.status === "refused" && admitted.reason === "rate_limited") return { status: "partial", counts, reason: "rate_limited" };
          // A refused commit is not an admission result and is never retried.
          receipt = await input.store.commitDispatch(next.ticket, admitted.status === "complete" ? "enqueue" : "refused",
            admitted.status === "complete" ? null : admitted.reason);
        }
        if (receipt.state === "needs_admission") return { status: "partial", counts, reason: "admission_changed" };
        counts[receipt.outcome]++;
        refusedEarlier ||= receipt.refused_count > 0;
        if (receipt.complete) { completed++; break; }
      }
      if (counts.visited >= 50 || input.deadline.remainingMs < 15_000) break;
    }
    const total = input.platform === "all" ? 2 : 1;
    return { status: disabled === total ? "disabled" : completed === total && !refusedEarlier ? "complete" : "partial", counts, reason: null };
  } catch (error) {
    if (isTargetRefusal(error)) return { status: "partial", counts, reason: "dispatch_changed" };
    return { status: "unavailable", counts, reason: error instanceof AnalyticsWorkerStopped
      ? error.reason === "admission_refused" ? "invalid_contract" : error.reason : "storage_unavailable" };
  }
}
