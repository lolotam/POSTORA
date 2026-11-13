import { modelBudgetRemaining, unseenStaffTurns, type StoredTurn } from "./logic.ts";

/** Each fallback spends the remaining invocation budget, including earlier failures. */
export async function answerWithinBudget<T>(input: {
  tiers: readonly T[];
  startedAt: number;
  ceilingMs: number;
  complete: (tier: T, timeoutMs: number) => Promise<string | null>;
  now?: () => number;
}): Promise<string | null> {
  for (const tier of input.tiers) {
    const remaining = modelBudgetRemaining(input.startedAt, (input.now ?? Date.now)());
    if (remaining <= 0) return null;
    try {
      const answer = await input.complete(tier, Math.min(input.ceilingMs, remaining));
      if (answer) return answer;
    } catch {
      // Exhaustion returns null so the caller preserves the question instead of sending a stale draft.
    }
  }
  return null;
}

/** A second provider call opens another race; verify its staff snapshot before sending. */
export async function refreshStaffDraft(input: {
  regenerate: () => Promise<string | null>;
  readLatest: () => Promise<{ readFailed: boolean; staffTurns: StoredTurn[] }>;
  known: StoredTurn[];
}): Promise<string | null> {
  const answer = await input.regenerate();
  if (!answer) return null;
  const latest = await input.readLatest();
  if (latest.readFailed) return null;
  return unseenStaffTurns(latest.staffTurns, input.known).length > 0 ? null : answer;
}
