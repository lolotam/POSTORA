// Deliberate browser mirror of supabase/functions/_shared/procedures/templates.ts.
// Deno and the browser cannot share that runtime module; the contract test keeps both copies aligned.
export const PROCEDURE_KEYS = ["order_status", "lead_capture", "complaint_return", "booking", "product_finder"] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
export const PROCEDURE_FIELDS: Record<ProcedureKey, string[]> = {
  order_status: ["order_number"],
  lead_capture: ["name", "contact", "product"],
  complaint_return: ["order_number", "problem"],
  booking: ["service", "when"],
  product_finder: [],
};
export const PROCEDURE_LIMITS = { text: 300, questionsMin: 2, questionsMax: 3, services: 20, service: 60 } as const;
export interface ProcedureSettings {
  enabled: boolean;
  prompts: Record<string, string>;
  closing: string;
  questions?: string[];
  services?: string[];
}
