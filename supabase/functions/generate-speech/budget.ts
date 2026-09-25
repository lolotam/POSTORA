/**
 * Bounds `generate-speech`'s total wall-clock time across its Vercel-tier fallback loop
 * to a single shared deadline, instead of letting each tier reuse the full per-tier
 * timeout independently. Three failing tiers at 45s each would otherwise sum to 135s,
 * well past the platform's ~60s edge-worker ceiling, and get killed with no response
 * and no log row (see memory: postora-edge-worker-60s-ceiling).
 *
 * Pure and side-effect free so it is trivial to unit test: `startedAt` and `now` are
 * both passed in rather than read from `Date.now()` internally.
 */

/** Below this much remaining budget, it is not worth starting another tier attempt. */
const MIN_REMAINING_MS = 5_000;

/**
 * Timeout to use for the next tier attempt, or `null` when too little of the total
 * budget remains to bother trying another tier.
 *
 * @param startedAt `Date.now()` when the tier loop began.
 * @param now `Date.now()` right before the next tier is attempted.
 * @param budgetMs Total wall-clock budget for the whole loop.
 * @param perTierMax The per-tier ceiling (never exceeded even with budget to spare).
 */
export function tierTimeout(
  startedAt: number,
  now: number,
  budgetMs: number,
  perTierMax: number,
): number | null {
  const remaining = budgetMs - (now - startedAt);
  if (remaining < MIN_REMAINING_MS) return null;
  return Math.min(perTierMax, remaining);
}
