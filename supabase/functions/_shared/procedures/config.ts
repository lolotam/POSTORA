// agent_behavior.procedures (Spec A, D8). Strict on save, lenient on read.
import { AgentBehaviorError } from "../agentBehaviorError.ts";
import { isEventProcedureKey, PROCEDURE_KEYS, type ProcedureKey, TEMPLATES } from "./templates.ts";

export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
  /** Owner attestation that checkout collects consent for WhatsApp order updates. */
  consent_attested_at?: string;
  /** Owner acknowledgement of the WhatsApp QR ban risk. Optional until the card requires it. */
  qr_risk_acknowledged_at?: string;
  /** review_request only. Days after completion before the opener, 0–14. */
  delay_days?: number;
  /** review_request only. https URL the model sends after a high rating. */
  review_url?: string;
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

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/;

function isoTimestamp(value: unknown, field: string): string {
  if (typeof value !== "string" || !ISO_TIMESTAMP.test(value) || Number.isNaN(Date.parse(value))) {
    fail(`${field} must be an ISO timestamp`);
  }
  return value;
}

function optionalIso(value: unknown, field: string): string | undefined {
  if (value === undefined) return undefined;
  return isoTimestamp(value, field);
}

function httpsUrl(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length > 500) fail(`${field} must be an https URL`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail(`${field} must be an https URL`);
  }
  if (url.protocol !== "https:") fail(`${field} must be an https URL`);
  return value;
}

function delayDays(value: unknown): number {
  if (value === undefined) return 3;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 14) {
    fail("procedures.review_request.delay_days must be an integer from 0 to 14");
  }
  return value;
}

/** Event flows are enable-able only with the settings §8 requires. A switched-off flow may omit them. */
function applyEventSettings(key: ProcedureKey, source: Record<string, unknown>, settings: ProcedureSettings): void {
  const qr = optionalIso(source.qr_risk_acknowledged_at, `procedures.${key}.qr_risk_acknowledged_at`);
  if (qr) settings.qr_risk_acknowledged_at = qr;
  if (key === "back_in_stock") return;
  if (key !== "cod_confirm" && key !== "review_request") return;
  if (settings.enabled) {
    settings.consent_attested_at = isoTimestamp(source.consent_attested_at, `procedures.${key}.consent_attested_at`);
  } else if (source.consent_attested_at !== undefined) {
    settings.consent_attested_at = isoTimestamp(source.consent_attested_at, `procedures.${key}.consent_attested_at`);
  }
  if (key === "review_request") {
    settings.delay_days = delayDays(source.delay_days);
    if (settings.enabled || source.review_url !== undefined) {
      settings.review_url = httpsUrl(source.review_url, "procedures.review_request.review_url");
    }
  }
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
  if (isEventProcedureKey(key)) applyEventSettings(key, source, settings);
  return settings;
}

export function parseProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) fail("procedures must be an object");
  const config: ProcedureConfig = {};
  for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
    if (!(PROCEDURE_KEYS as readonly string[]).includes(key)) fail(`Unknown procedure: ${key}`);
    config[key as ProcedureKey] = parseSettings(key as ProcedureKey, value);
  }
  return config;
}

/** The reply path must never fail on stored config: an invalid flow counts as disabled. */
export function readProcedureConfig(input: unknown): ProcedureConfig {
  if (typeof input !== "object" || input === null || Array.isArray(input)) return {};
  const config: ProcedureConfig = {};
  for (const key of PROCEDURE_KEYS) {
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

/** review_request delay stored on the account, or 3 when that flow is absent or invalid. */
export function reviewDelayDays(procedures: unknown): number {
  if (typeof procedures !== "object" || procedures === null || Array.isArray(procedures)) return 3;
  const value = (procedures as Record<string, unknown>).review_request;
  if (value === undefined) return 3;
  try {
    return parseSettings("review_request", value).delay_days ?? 3;
  } catch (error) {
    if (!(error instanceof AgentBehaviorError)) throw error;
    console.warn(`[procedures] ignoring invalid review_request config: ${error.message}`);
    return 3;
  }
}
