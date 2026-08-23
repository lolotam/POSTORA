import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Pins the C1 fix from the 2026-08-23 final whole-branch review: a
// subscription must entitle its plan while status is 'active' OR
// 'past_due'. Dunning is a payment-collection state, not an entitlement
// state - Stripe keeps the subscription open for the whole retry window
// (stripe-webhook/index.ts writes status: "past_due" on
// invoice.payment_failed, it never cancels anything), so treating
// 'past_due' as unentitled would silently downgrade a paying customer to
// free-tier limits the moment a card fails.
//
// The arbiter (effective_user_quotas) and the backfill's plan-selection CTE
// are two implementations of one rule and must use the identical predicate,
// or a user can resolve to a different plan depending on which one runs.
const ARBITER_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260823140100_effective_user_quotas.sql",
);
const BACKFILL_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260823140400_backfill_user_quota_overrides.sql",
);

const ENTITLEMENT_PREDICATE = "status IN ('active', 'past_due')";
// A bare active-only equality test on a user_subscriptions status column,
// as it existed before the fix. Matches "us.status = 'active'" and
// "s.status = 'active'" but not the IN(...) predicate above.
//
// F7 (CodeRabbit round 1, 2026-08-23): the trailing \b used to sit AFTER
// the closing quote ("...'active'\b"). Both characters adjacent to that
// position are non-word (the quote itself, and whatever follows — a
// newline/space in this SQL text), so \b can never match there and this
// regex could never match ANY input — the two "has no remaining
// active-only equality test" assertions below passed vacuously regardless
// of what the migration file contained. Moving \b to right after "active"
// (a word char) and before the closing quote (non-word) restores a real
// word boundary, so the pattern can actually match.
const STALE_ACTIVE_ONLY_TEST = /\b\w+\.status = 'active\b'/;

describe("effective_user_quotas() entitlement predicate (migration 20260823140100)", () => {
  it("treats past_due as entitled in both the plan branch and the free-plan fallback branch", () => {
    const sql = readFileSync(ARBITER_PATH, "utf8");
    const occurrences = sql.split(ENTITLEMENT_PREDICATE).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it("has no remaining active-only equality test on user_subscriptions.status", () => {
    const sql = readFileSync(ARBITER_PATH, "utf8");
    expect(sql).not.toMatch(STALE_ACTIVE_ONLY_TEST);
  });
});

describe("backfill plan-selection CTE entitlement predicate (migration 20260823140400)", () => {
  it("uses the identical entitlement predicate as the arbiter", () => {
    const sql = readFileSync(BACKFILL_PATH, "utf8");
    expect(sql).toContain(ENTITLEMENT_PREDICATE);
  });

  it("has no remaining active-only equality test on user_subscriptions.status", () => {
    const sql = readFileSync(BACKFILL_PATH, "utf8");
    expect(sql).not.toMatch(STALE_ACTIVE_ONLY_TEST);
  });
});
