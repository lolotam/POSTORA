// agent_behavior.procedures (Spec A, D8). Strict on save, lenient on read.
import { AgentBehaviorError } from "../agentBehaviorError.ts";
import { isEventProcedureKey, PROCEDURE_KEYS, type ProcedureKey, TEMPLATES } from "./templates.ts";

export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
}
export type ProcedureConfig = Partial<Record<ProcedureKey, ProcedureSettings>>;

const MAX_TEXT = 300;
const MAX_SERVICES = 20;
const MAX_SERVICE = 60;

function fail(message: string): never {
  throw new AgentBehaviorError(message);
}

function boundedText(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || value.length > max) fail(`${field} must be text of at most ${max} characters`);
  return value;
}

/** A question or service the agent will say aloud: blank text would reach the customer as nothing. */
function nonBlankText(value: unknown, field: string, max: number): string {
  const text = boundedText(value, field, max);
  if (!text.trim()) fail(`${field} must not be blank`);
  return text;
}

function parseQuestions(questions: unknown): string[] {
  if (!Array.isArray(questions) || questions.length < 2 || questions.length > 3) {
    fail("procedures.product_finder.questions must hold 2 or 3 questions");
  }
  return questions.map((q, i) => nonBlankText(q, `procedures.product_finder.questions[${i}]`, MAX_TEXT));
}

function parseSettings(key: ProcedureKey, value: unknown): ProcedureSettings {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(`procedures.${key} must be an object`);
  const source = value as Record<string, unknown>;
  if (typeof source.enabled !== "boolean") fail(`procedures.${key}.enabled must be true or false`);
  const fieldNames = new Set(TEMPLATES[key].fields.map((field) => field.name));
  const promptsIn = (source.prompts ?? {}) as Record<string, unknown>;
  if (typeof promptsIn !== "object" || Array.isArray(promptsIn)) fail(`procedures.${key}.prompts must be an object`);
  const prompts: Record<string, string> = {};
  for (const [name, text] of Object.entries(promptsIn)) {
    if (!fieldNames.has(name)) fail(`procedures.${key}.prompts.${name} is not a field of this procedure`);
    prompts[name] = boundedText(text, `procedures.${key}.prompts.${name}`, MAX_TEXT);
  }
  const settings: ProcedureSettings = {
    enabled: source.enabled,
    prompts,
    closing: boundedText(source.closing ?? "", `procedures.${key}.closing`, MAX_TEXT),
  };
  if (key === "product_finder") {
    // Questions are required only while the flow is on; a switched-off flow keeps a valid
    // draft and drops an unfinished one, so it can never block saving (PR #209 review).
    try {
      settings.questions = parseQuestions(source.questions);
    } catch (error) {
      if (settings.enabled || !(error instanceof AgentBehaviorError)) throw error;
    }
  }
  if (key === "booking" && source.services !== undefined) {
    if (!Array.isArray(source.services) || source.services.length > MAX_SERVICES) {
      fail(`procedures.booking.services must hold at most ${MAX_SERVICES} items`);
    }
    settings.services = source.services.map((s, i) => nonBlankText(s, `procedures.booking.services[${i}]`, MAX_SERVICE));
  }
  return settings;
}

export function parseProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("procedures must be an object");
  const config: ProcedureConfig = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (isEventProcedureKey(key) || !(PROCEDURE_KEYS as readonly string[]).includes(key)) fail(`Unknown procedure: ${key}`);
    config[key as ProcedureKey] = parseSettings(key as ProcedureKey, value);
  }
  return config;
}

/** The reply path must never fail on stored config: an invalid flow counts as disabled. */
export function readProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const config: ProcedureConfig = {};
  for (const key of PROCEDURE_KEYS) {
    if (isEventProcedureKey(key)) continue; // Spec B PR 1: no event flow can be switched on yet
    const value = (input as Record<string, unknown>)[key];
    if (value === undefined) continue;
    try {
      config[key] = parseSettings(key, value);
    } catch (error) {
      if (!(error instanceof AgentBehaviorError)) throw error;
      console.warn(`[procedures] ignoring invalid ${key} config: ${error.message}`);
    }
  }
  return config;
}

export function enabledProcedures(config: ProcedureConfig): ProcedureKey[] {
  return PROCEDURE_KEYS.filter((key) => config[key]?.enabled === true);
}
