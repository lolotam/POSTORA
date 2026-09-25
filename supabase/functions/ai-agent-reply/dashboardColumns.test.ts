import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import type { TriageOutcome } from "../_shared/agentTriage.ts";
import { dashboardColumns } from "./dashboardColumns.ts";

const outcome = (overrides: {
  intent?: TriageOutcome["answers"]["intent"];
  skipKnowledge?: boolean;
}): TriageOutcome => ({
  provider: "openrouter",
  model: "triage-model",
  latencyMs: 120,
  answers: {
    needsKnowledge: null,
    smalltalk: null,
    handoff: null,
    connector: null,
    intent: overrides.intent ?? null,
  },
  plan: { skipKnowledge: overrides.skipKnowledge ?? false, smalltalk: false, handoff: false, connectors: "all" },
});

Deno.test("no triage and no model: every column is null", () => {
  assertEquals(dashboardColumns({}), { intent: null, triage_fast_path: null, used_model: null });
});

Deno.test("a triage run with no outcome (every tier failed) leaves the triage columns null", () => {
  const cols = dashboardColumns({ triage: { outcome: null, errors: [{ model: "m", error: "timeout" }] } });
  assertEquals(cols.intent, null);
  assertEquals(cols.triage_fast_path, null);
});

Deno.test("a confident intent is recorded, and the fast path follows plan.skipKnowledge", () => {
  const cols = dashboardColumns({
    triage: { outcome: outcome({ intent: { choice: "pricing", confidence: 0.92 }, skipKnowledge: true }), errors: null },
    used_model: "openrouter/openai/gpt-4o-mini",
  });
  assertEquals(cols, { intent: "pricing", triage_fast_path: true, used_model: "openrouter/openai/gpt-4o-mini" });
});

Deno.test("an intent below the label threshold is not recorded, but triage still ran", () => {
  const cols = dashboardColumns({
    triage: { outcome: outcome({ intent: { choice: "complaint", confidence: 0.79 } }), errors: null },
  });
  assertEquals(cols.intent, null);
  assertEquals(cols.triage_fast_path, false);
});

Deno.test("'other' is a real intent for the dashboard even though it earns no label", () => {
  const cols = dashboardColumns({
    triage: { outcome: outcome({ intent: { choice: "other", confidence: 0.95 } }), errors: null },
  });
  assertEquals(cols.intent, "other");
});

Deno.test("malformed metadata is ignored rather than trusted", () => {
  assertEquals(
    dashboardColumns({ triage: "yes", used_model: 42 }),
    { intent: null, triage_fast_path: null, used_model: null },
  );
  assertEquals(
    dashboardColumns({ triage: { outcome: { answers: { intent: { choice: "bribe", confidence: 1 } }, plan: {} } } }),
    { intent: null, triage_fast_path: null, used_model: null },
  );
});
