// The ai_agent_logs columns the user's AI Agent dashboard reads (migration
// 20260926100000). The same facts are written to system_logs.metadata, but
// system_logs is admin-only under RLS, so the dashboard needs its own copy on
// the user-facing row. Derived from logOutcome's `meta` so every outcome path
// that already reports triage and the model fills them without a change.
import { INTENTS, TRIAGE_CONFIDENCE, type Intent } from "../_shared/agentTriage.ts";

export interface DashboardColumns {
  /** Triage intent at or above the label threshold; null when unsure or absent. */
  intent: Intent | null;
  /** plan.skipKnowledge when triage produced a plan; null when triage did not run. */
  triage_fast_path: boolean | null;
  /** provider/model of the last model that answered. */
  used_model: string | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function dashboardColumns(meta: Record<string, unknown>): DashboardColumns {
  const triage = isRecord(meta.triage) ? meta.triage : null;
  const outcome = triage && isRecord(triage.outcome) ? triage.outcome : null;
  const answers = outcome && isRecord(outcome.answers) ? outcome.answers : null;
  const plan = outcome && isRecord(outcome.plan) ? outcome.plan : null;
  const intent = answers && isRecord(answers.intent) ? answers.intent : null;

  const confidentIntent = intent &&
      typeof intent.choice === "string" && (INTENTS as readonly string[]).includes(intent.choice) &&
      typeof intent.confidence === "number" && intent.confidence >= TRIAGE_CONFIDENCE
    ? intent.choice as Intent
    : null;

  return {
    intent: confidentIntent,
    triage_fast_path: plan && typeof plan.skipKnowledge === "boolean" ? plan.skipKnowledge : null,
    used_model: typeof meta.used_model === "string" && meta.used_model ? meta.used_model : null,
  };
}
