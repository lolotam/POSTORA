// Pure procedure state transitions (Spec A, D3–D5). Callers pass time and ids in.
import {
  CLAIM_LEASE_MS, EVENT_STALE_AFTER_MS, OFF_SCRIPT_LIMIT, type ProcedureField, type ProcedureKey, type ProcedureOrigin,
  STALE_AFTER_MS, TEMPLATES,
} from "./templates.ts";
import type { OpenerLanguage } from "./openers.ts";

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
  /** Set only by the compare-and-set that won the end action, so the claimed value differs from the stored one. */
  claimed_by?: string;
  /** When the claim was taken; another run's claim younger than CLAIM_LEASE_MS is still in flight. */
  claimed_at?: string;
  /** Set by the store-event worker. pending_opener is not a live procedure yet. */
  phase?: "pending_opener" | "active";
  /**
   * Store-event flows only: the language the worker sent the opener in, fixed when the state is
   * first written. The account's language setting can change during the flow's 72 hours.
   */
  opener_language?: OpenerLanguage;
}

/** Customers answer a business-started template late, so event flows live longer. */
export function staleAfterMs(origin: ProcedureOrigin | undefined): number {
  return origin === "event" ? EVENT_STALE_AFTER_MS : STALE_AFTER_MS;
}

/** The worker has written the state but the opener is not yet accepted: not a live flow. */
export function isPendingOpener(value: unknown): boolean {
  return typeof value === "object" && value !== null && (value as { phase?: unknown }).phase === "pending_opener";
}

/**
 * A pending opener the worker may still confirm. Missing or unparseable `updated_at` is not live,
 * so a stranded opener can be cleared. `isPendingOpener` stays the raw phase check.
 */
export function isLivePendingOpener(value: unknown, now: Date): boolean {
  if (!isPendingOpener(value)) return false;
  const state = value as { updated_at?: unknown; origin?: unknown };
  if (typeof state.updated_at !== "string" || !Number.isFinite(Date.parse(state.updated_at))) return false;
  const origin = state.origin === "event" || state.origin === "jev" || state.origin === "model"
    ? state.origin
    : undefined;
  return now.getTime() - Date.parse(state.updated_at) <= staleAfterMs(origin);
}

function fieldDue(field: ProcedureField, collected: Record<string, string>): boolean {
  return field.when ? field.when(collected) : true;
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

/** True while another run's claim on this flow may still be running its end action. */
export function claimHeldByOther(state: ProcedureState, runId: string, now: Date): boolean {
  if (!state.claimed_by || state.claimed_by === runId) return false;
  const age = now.getTime() - Date.parse(state.claimed_at ?? "");
  return age >= 0 && age < CLAIM_LEASE_MS;
}

export function nextField(state: ProcedureState, fields: ProcedureField[]): ProcedureField | null {
  return fields.find((field) => fieldDue(field, state.fields) && !(field.name in state.fields)) ?? null;
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
  const step = fields.findIndex((field) => fieldDue(field, collected) && !(field.name in collected));
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
  return now.getTime() - Date.parse(state.updated_at) > staleAfterMs(state.origin) ? null : state;
}

function isStoredState(value: unknown): value is ProcedureState {
  if (typeof value !== "object" || value === null) return false;
  const state = value as Record<string, unknown>;
  return typeof state.run_id === "string" && typeof state.key === "string" &&
    typeof state.step === "number" && typeof state.off_script === "number" &&
    typeof state.fields === "object" && state.fields !== null && !Array.isArray(state.fields) &&
    Object.values(state.fields).every((field) => typeof field === "string") &&
    typeof state.updated_at === "string" && Number.isFinite(Date.parse(state.updated_at)) &&
    (state.claimed_by === undefined || typeof state.claimed_by === "string") &&
    (state.claimed_at === undefined || typeof state.claimed_at === "string") &&
    (state.phase === undefined || state.phase === "pending_opener" || state.phase === "active") &&
    (state.opener_language === undefined || state.opener_language === "ar" || state.opener_language === "en") &&
    (state.origin === undefined || state.origin === "jev" || state.origin === "model" || state.origin === "event");
}
