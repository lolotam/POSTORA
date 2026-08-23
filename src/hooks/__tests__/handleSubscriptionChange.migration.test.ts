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
// Fix: gate the PERFORM on TG_OP = 'INSERT' OR OLD.plan_id IS DISTINCT FROM
// NEW.plan_id, so only a REAL entitlement change clears overrides.
const WRITERS_MIGRATION_PATH = resolve(
  __dirname,
  "../../../supabase/migrations/20260823140300_quota_writers_clear_overrides.sql",
);

describe("handle_subscription_change() only clears overrides on a real plan change (migration 20260823140300)", () => {
  it("redefines handle_subscription_change() in this migration (not left as the unconditional 20260112200222 version)", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    const matches = sql.match(
      /CREATE OR REPLACE FUNCTION public\.handle_subscription_change\(\)/g,
    );
    expect(matches?.length ?? 0).toBeGreaterThanOrEqual(1);
  });

  it("gates the set_user_quotas_for_plan PERFORM on TG_OP = 'INSERT' OR a real plan_id change", () => {
    const sql = readFileSync(WRITERS_MIGRATION_PATH, "utf8");
    // Isolate the handle_subscription_change() function body so this
    // assertion cannot accidentally match an unrelated guard elsewhere in
    // the file.
    const fnStart = sql.indexOf("CREATE OR REPLACE FUNCTION public.handle_subscription_change()");
    expect(fnStart).toBeGreaterThan(-1);
    const fnBody = sql.slice(fnStart, fnStart + 1500);

    expect(fnBody).toContain("TG_OP = 'INSERT'");
    expect(fnBody).toMatch(/OLD\.plan_id\s+IS\s+DISTINCT\s+FROM\s+NEW\.plan_id/);
    expect(fnBody).toContain("PERFORM set_user_quotas_for_plan");
  });
});
