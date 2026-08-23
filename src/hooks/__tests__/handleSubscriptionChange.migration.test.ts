import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// F4 (CodeRabbit round 1, 2026-08-23): handle_subscription_change() is a
// trigger on `AFTER INSERT OR UPDATE OF plan_id ON user_subscriptions`.
// Postgres's "UPDATE OF column" fires whenever that column is named in the
// UPDATE's SET list — NOT only when its value actually differs — so
// AdminUsers.tsx's applySubscriptionPlan() (which always does
// `UPDATE ... SET plan_id = <planId>, ...` even when reassigning the SAME
// plan) fires this trigger every time. Before the fix, the trigger
// unconditionally called set_user_quotas_for_plan(), which clears every
// per-user override — silently destroying a deliberate admin grant on a
// same-plan "Change Plan" click that changed nothing.
//
// R1 (CodeRabbit round 2, 2026-08-23): the round-1 fix gated the PERFORM on
// `TG_OP = 'INSERT' OR OLD.plan_id IS DISTINCT FROM NEW.plan_id` — a single
// OR expression. OLD is NOT ASSIGNED for an INSERT trigger, and PostgreSQL
// does not guarantee left-to-right evaluation of OR operands, so this could
// evaluate `OLD.plan_id` on an INSERT and raise
// `record "old" is not assigned yet`, failing every new subscription's
// INSERT. Fix: split into explicit `IF TG_OP = 'INSERT' THEN ... ELSIF
// OLD.plan_id IS DISTINCT FROM NEW.plan_id THEN ... END IF` branches, so OLD
// is never referenced on the branch that runs for an INSERT.
const WRITERS_MIGRATION_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260823140300_quota_writers_clear_overrides.sql",
);

function extractHandleSubscriptionChangeBody(sql: string): string {
  const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.handle_subscription_change()");
  expect(fnStart).toBeGreaterThan(-1);
  return sql.slice(fnStart, fnStart + 1800);
}

describe("handle_subscription_change() only clears overrides on a real plan change (migration 20260823140300)", () => {
  it("redefines handle_subscription_change() in this migration (not left as the unconditional 20260112200222 version)", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    const matches = sql.match(
      /CREATE OR REPLACE FUNCTION public\.handle_subscription_change\(\)/g,
    );
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  // R1: the fused single-OR guard is the exact shape that can dereference
  // OLD before it is assigned on an INSERT. Its absence is the proof this
  // migration no longer takes that path.
  it("does not fuse TG_OP = 'INSERT' and the OLD.plan_id check into a single OR expression", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    const fnBody = extractHandleSubscriptionChangeBody(sql);
    expect(fnBody).not.toMatch(/TG_OP\s*=\s*'INSERT'\s+OR\s+OLD\.plan_id/);
  });

  it("branches explicitly: IF TG_OP = 'INSERT' THEN ... ELSIF OLD.plan_id IS DISTINCT FROM NEW.plan_id THEN ...", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    const fnBody = extractHandleSubscriptionChangeBody(sql);

    expect(fnBody).toMatch(/IF\s+TG_OP\s*=\s*'INSERT'\s+THEN/);
    expect(fnBody).toMatch(/ELSIF\s+OLD\.plan_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.plan_id\s+THEN/);
  });

  it("calls PERFORM set_user_quotas_for_plan in both the INSERT branch and the real-plan-change branch", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    const fnBody = extractHandleSubscriptionChangeBody(sql);

    const insertBranchStart = fnBody.search(/IF\s+TG_OP\s*=\s*'INSERT'\s+THEN/);
    const elsifStart = fnBody.search(/ELSIF\s+OLD\.plan_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.plan_id\s+THEN/);
    const endIfStart = fnBody.indexOf("END IF;", elsifStart);
    expect(insertBranchStart).toBeGreaterThan(-1);
    expect(elsifStart).toBeGreaterThan(insertBranchStart);
    expect(endIfStart).toBeGreaterThan(elsifStart);

    const insertBranch = fnBody.slice(insertBranchStart, elsifStart);
    const elsifBranch = fnBody.slice(elsifStart, endIfStart);

    expect(insertBranch).toContain("PERFORM set_user_quotas_for_plan");
    expect(elsifBranch).toContain("PERFORM set_user_quotas_for_plan");
  });
});
