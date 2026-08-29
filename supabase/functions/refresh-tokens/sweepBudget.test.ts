import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ACCOUNT_WORST_CASE_MS,
  SWEEP_BUDGET_MS,
  mayStartAnotherAccount,
} from "./sweepBudget.ts";

// Regression guard (Codex review round 3, PR #69). The budget check must ask whether the
// WORST CASE for one more account still fits, not whether the budget is already spent.
// These assertions import the real constants rather than restating them, so a change to
// either number is caught here instead of quietly invalidating the test.

/** The edge worker is killed at this point; it is the fact every assertion below rests on. */
const WORKER_CEILING_MS = 60_000;

Deno.test("an account started at the deadline still finishes inside the worker ceiling", () => {
  const lastAllowedStart = SWEEP_BUDGET_MS - ACCOUNT_WORST_CASE_MS;
  assertEquals(mayStartAnotherAccount(lastAllowedStart), true);
  assertEquals(lastAllowedStart + ACCOUNT_WORST_CASE_MS <= WORKER_CEILING_MS, true);
});

Deno.test("no account is started once its worst case would overrun the ceiling", () => {
  // 44.9s passed the old elapsed-only check, yet 44.9 + 24 = 68.9s is past the ceiling.
  assertEquals(mayStartAnotherAccount(44_900), false);
  assertEquals(44_900 + ACCOUNT_WORST_CASE_MS > WORKER_CEILING_MS, true);
});

Deno.test("the reserve leaves headroom to persist results after the last account", () => {
  const worstCaseFinish = SWEEP_BUDGET_MS;
  assertEquals(WORKER_CEILING_MS - worstCaseFinish >= 15_000, true);
});

Deno.test("a sweep that has only just started may proceed", () => {
  assertEquals(mayStartAnotherAccount(0), true);
});
