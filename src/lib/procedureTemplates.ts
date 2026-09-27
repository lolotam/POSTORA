// Deliberate browser mirror of supabase/functions/_shared/procedures/templates.ts.
// Deno and the browser cannot share that runtime module; the contract test keeps both copies aligned.
export const PROCEDURE_KEYS = [
  "order_status", "lead_capture", "complaint_return", "booking", "product_finder",
  "cod_confirm", "review_request", "back_in_stock",
] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
/** Store-event flows. The worker starts them; the model cannot. */
export const EVENT_PROCEDURE_KEYS = ["cod_confirm", "review_request", "back_in_stock"] as const;
export type EventProcedureKey = typeof EVENT_PROCEDURE_KEYS[number];
export function isEventProcedureKey(key: string): boolean {
  return (EVENT_PROCEDURE_KEYS as readonly string[]).includes(key);
}
export const PROCEDURE_FIELDS: Record<ProcedureKey, string[]> = {
  order_status: ["order_number"],
  lead_capture: ["name", "contact", "product"],
  complaint_return: ["order_number", "problem"],
  booking: ["service", "when"],
  product_finder: [],
  cod_confirm: ["decision"],
  review_request: ["rating", "problem"],
  back_in_stock: ["interest"],
};
export const PROCEDURE_LIMITS = { text: 300, questionsMin: 2, questionsMax: 3, services: 20, service: 60 } as const;
export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
  /** Owner attestation that checkout collects consent for WhatsApp order updates. */
  consent_attested_at?: string;
  /** Owner acknowledgement of the WhatsApp ban risk on a QR session. */
  qr_risk_acknowledged_at?: string;
  /** review_request only. Days after completion before the opener, 0–14. */
  delay_days?: number;
  /** review_request only. https URL sent after a high rating. */
  review_url?: string;
}

export type EventEnableRefusal =
  | "agent_disabled"
  | "human_first"
  | "read_only"
  | "consent_required"
  | "qr_risk_required"
  | "review_delay"
  | "review_url";

export function reviewDelayValue(value: number): number | null {
  return Number.isInteger(value) && value >= 0 && value <= 14 ? value : null;
}

export function isHttpsReviewUrl(value: string): boolean {
  if (value.length === 0 || value.length > 500) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Why a store-event flow cannot be switched on, or null when it can. */
export function eventEnableRefusal(input: {
  key: EventProcedureKey;
  agentEnabled: boolean;
  defaultMode: string;
  connectionMode: string | null;
  wooReadOnly: boolean;
  consentAttested: boolean;
  qrRiskAcknowledged: boolean;
  delayDays: number;
  reviewUrl: string;
}): EventEnableRefusal | null {
  if (!input.agentEnabled) return "agent_disabled";
  if (input.defaultMode === "human_first") return "human_first";
  if (input.key === "cod_confirm" && input.wooReadOnly) return "read_only";
  if ((input.key === "cod_confirm" || input.key === "review_request") && !input.consentAttested) return "consent_required";
  if (input.connectionMode === "evolution_qr" && !input.qrRiskAcknowledged) return "qr_risk_required";
  if (input.key === "review_request") {
    if (reviewDelayValue(input.delayDays) === null) return "review_delay";
    if (!isHttpsReviewUrl(input.reviewUrl)) return "review_url";
  }
  return null;
}

export function showsEventTemplateStatus(connectionMode: string | null | undefined): boolean {
  return connectionMode === "cloud_api" || connectionMode === "coexistence";
}

/** Mirrors procedureTurnGate in ai-agent-reply/logic.ts: DMs on these platforms only. */
const PROCEDURE_PLATFORMS = ["whatsapp", "facebook", "instagram"];

export function supportsProcedures(platform: string, surface: "dms" | "comments" | "both"): boolean {
  return PROCEDURE_PLATFORMS.includes(platform) && surface !== "comments";
}
