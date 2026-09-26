// Procedure templates (Spec A, D2). Pure data plus validators; no I/O.
import type { Intent } from "../agentTriage.ts";

export const PROCEDURE_KEYS = ["order_status", "lead_capture", "complaint_return", "booking", "product_finder"] as const;
export type ProcedureKey = typeof PROCEDURE_KEYS[number];
export type ProcedureOrigin = "jev" | "model" | "event";
export type EndAction = "order_lookup" | "save_lead" | "handoff" | "save_booking" | "product_search";

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const OFF_SCRIPT_LIMIT = 3;

export interface ProcedureField {
  name: string;
  /** Normalized value, or null when the input does not satisfy the field. */
  validate: (raw: string) => string | null;
}

export interface ProcedureTemplate {
  key: ProcedureKey;
  version: number;
  fields: ProcedureField[];
  endAction: EndAction;
  /** A store capability the account must have, or the flow cannot start. */
  needsCapability?: "lookup_orders" | "search_products";
}

const text = (max: number) => (raw: string) => {
  const value = raw.trim();
  return value.length >= 1 && value.length <= max ? value : null;
};
const orderNumber = (raw: string) => {
  const value = raw.trim().replace(/^#/, "");
  return /^\d{1,12}$/.test(value) ? value : null;
};
const contact = (raw: string) => {
  const value = raw.trim();
  return value.length >= 3 && value.length <= 120 ? value : null;
};

export function productFinderFields(count: number): ProcedureField[] {
  return Array.from({ length: count }, (_, index) => ({ name: `answer_${index + 1}`, validate: text(300) }));
}

export const TEMPLATES: Record<ProcedureKey, ProcedureTemplate> = {
  order_status: {
    key: "order_status", version: 1, endAction: "order_lookup", needsCapability: "lookup_orders",
    fields: [{ name: "order_number", validate: orderNumber }],
  },
  lead_capture: {
    key: "lead_capture", version: 1, endAction: "save_lead",
    fields: [
      { name: "name", validate: text(120) },
      { name: "contact", validate: contact },
      { name: "product", validate: text(500) },
    ],
  },
  complaint_return: {
    // No photo field (debate verdict 11): the request carries no attachment reference, and the
    // human who takes the handoff sees any photo in the chat itself.
    key: "complaint_return", version: 1, endAction: "handoff",
    fields: [
      { name: "order_number", validate: orderNumber },
      { name: "problem", validate: text(500) },
    ],
  },
  booking: {
    key: "booking", version: 1, endAction: "save_booking",
    fields: [
      { name: "service", validate: text(120) },
      { name: "when", validate: text(120) },
    ],
  },
  product_finder: {
    // Fields come from the business's 2–3 questions: productFinderFields(questions.length).
    key: "product_finder", version: 1, endAction: "product_search", needsCapability: "search_products",
    fields: [],
  },
};

/** Jev intent → procedure. product_finder is deliberately absent (Spec A, D3). */
export const JEV_START: Partial<Record<Intent, ProcedureKey>> = {
  order_status: "order_status",
  lead: "lead_capture",
  complaint: "complaint_return",
  booking: "booking",
};
