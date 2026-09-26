// Pure procedure state transitions (Spec A, D3–D5). Callers pass time and ids in.
import { OFF_SCRIPT_LIMIT, type ProcedureField, type ProcedureKey, type ProcedureOrigin, STALE_AFTER_MS, TEMPLATES } from "./templates.ts";

export interface ProcedureState {
  run_id: string;
  key: ProcedureKey;
  version: number;
  step: number;
  fields: Record<string, string>;
  off_script: number;
  origin: ProcedureOrigin;
  started_at: string;
  updated_at: string;
}

export interface SubmitResult {
  state: ProcedureState;
  accepted: string[];
  rejected: Array<{ field: string; reason: "invalid" | "unknown" }>;
  complete: boolean;
}

export function startProcedure(
  state: ProcedureState | null,
  key: ProcedureKey,
  origin: ProcedureOrigin,
  now: Date,
  runId: string,
): { state: ProcedureState; started: boolean } {
  if (state) return { state, started: false };
  const at = now.toISOString();
  return {
    started: true,
    state: {
      run_id: runId, key, version: TEMPLATES[key].version, step: 0, fields: {}, off_script: 0,
      origin, started_at: at, updated_at: at,
    },
  };
}

export function nextField(state: ProcedureState, fields: ProcedureField[]): ProcedureField | null {
  return fields.find((field) => !(field.name in state.fields)) ?? null;
}

export function submitFields(
  state: ProcedureState,
  fields: ProcedureField[],
  input: Record<string, unknown>,
  now: Date,
): SubmitResult {
  const byName = new Map(fields.map((field) => [field.name, field]));
  const collected = { ...state.fields };
  const accepted: string[] = [];
  const rejected: SubmitResult["rejected"] = [];
  for (const [name, raw] of Object.entries(input)) {
    const field = byName.get(name);
    if (!field) {
      rejected.push({ field: name, reason: "unknown" });
      continue;
    }
    const value = typeof raw === "string" ? field.validate(raw) : null;
    if (value === null) {
      rejected.push({ field: name, reason: "invalid" });
      continue;
    }
    collected[name] = value;
    accepted.push(name);
  }
  const step = fields.findIndex((field) => !(field.name in collected));
  const next: ProcedureState = {
    ...state,
    fields: collected,
    step: step === -1 ? fields.length : step,
    off_script: accepted.length ? 0 : state.off_script,
    updated_at: now.toISOString(),
  };
  return { state: next, accepted, rejected, complete: step === -1 };
}

/** One more consecutive off-script turn; null once the limit is reached. */
export function recordOffScript(state: ProcedureState, now: Date): ProcedureState | null {
  const offScript = state.off_script + 1;
  if (offScript >= OFF_SCRIPT_LIMIT) return null;
  return { ...state, off_script: offScript, updated_at: now.toISOString() };
}

/** Lazy expiry: evaluated at the start of a turn, never by a cron job. */
export function expireIfStale(state: ProcedureState | null, now: Date): ProcedureState | null {
  // The column is owner-writable through ai_threads RLS, so a stored value is untrusted shape.
  if (!isStoredState(state)) return null;
  const template = TEMPLATES[state.key];
  if (!template || state.version !== template.version) return null;
  return now.getTime() - Date.parse(state.updated_at) > STALE_AFTER_MS ? null : state;
}

function isStoredState(value: unknown): value is ProcedureState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.run_id === "string" && typeof state.key === "string" &&
    typeof state.step === "number" && typeof state.off_script === "number" &&
    typeof state.fields === "object" && state.fields !== null && !Array.isArray(state.fields) &&
    Object.values(state.fields).every((field) => typeof field === "string") &&
    typeof state.updated_at === "string" && Number.isFinite(Date.parse(state.updated_at));
}
