// Deliberate browser mirror of supabase/functions/_shared/procedures/templates.ts.
// Deno and the browser cannot share that runtime module; the contract test keeps both copies aligned.
export const PROCEDURE_KEYS = [
  "order_status", "lead_capture", "complaint_return", "booking", "product_finder",
  "cod_confirm", "review_request", "back_in_stock",
] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
/** Store-event flows. The server refuses them on save until their toggles ship (Spec B PR 2). */
export const EVENT_PROCEDURE_KEYS = ["cod_confirm", "review_request", "back_in_stock"] as const;
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
}

/** Mirrors procedureTurnGate in ai-agent-reply/logic.ts: DMs on these platforms only. */
const PROCEDURE_PLATFORMS = ["whatsapp", "facebook", "instagram"];

export function supportsProcedures(platform: string, surface: "dms" | "comments" | "both"): boolean {
  return PROCEDURE_PLATFORMS.includes(platform) && surface !== "comments";
}
