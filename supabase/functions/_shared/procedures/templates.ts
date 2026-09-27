// Procedure templates (Spec A, D2). Pure data plus validators; no I/O.
import type { Intent } from "../agentTriage.ts";

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
export type ProcedureOrigin = "jev" | "model" | "event";
export type EndAction =
  | "order_lookup" | "save_lead" | "handoff" | "save_booking" | "product_search"
  | "cod_update" | "review_route" | "stock_offer";

export const STALE_AFTER_MS = 24 * 60 * 60 * 1000;
export const EVENT_STALE_AFTER_MS = 72 * 60 * 60 * 1000;
export const OFF_SCRIPT_LIMIT = 3;
/** Longer than an edge worker lives (60 s), so a live claim is never taken over mid end action. */
export const CLAIM_LEASE_MS = 2 * 60 * 1000;

export interface ProcedureField {
  name: string;
  /** What counts as an answer. Wording says how to ask; the hint says what to accept. */
  hint?: string;
  /** When omitted, the field is always required. Otherwise it is required only while this is true. */
  when?: (fields: Record<string, string>) => boolean;
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
/** Case and Arabic alef/hamza folded, so the lists below hold the folded spelling. */
const fold = (raw: string) => raw.trim().toLowerCase().replace(/[أإآٱ]/g, "ا");
const decision = (raw: string) => {
  const value = fold(raw);
  if (["confirm", "yes", "نعم", "تاكيد"].includes(value)) return "confirm";
  if (["cancel", "no", "لا", "الغاء"].includes(value)) return "cancel";
  return null;
};
const arabicDigits = (raw: string) => raw.trim()
  .replace(/[٠-٩]/g, (digit) => String(digit.charCodeAt(0) - 0x0660))
  .replace(/[۰-۹]/g, (digit) => String(digit.charCodeAt(0) - 0x06f0));
const rating = (raw: string) => {
  const value = arabicDigits(raw);
  return /^[1-5]$/.test(value) ? value : null;
};
const interest = (raw: string) => {
  const value = fold(raw);
  if (value === "yes" || value === "نعم") return "yes";
  if (value === "no" || value === "لا") return "no";
  return null;
};

const hint = {
  order_number: "the order number; digits, a leading # is fine",
  name: "the customer's name",
  contact: "a phone number or an area/city (for example Salmiya); accept either, do not insist on a phone number",
  product: "the product or service they are interested in",
  problem: "a short description of the problem",
  service: "the service they want",
  when: "the day and time they prefer, in their own words",
} as const;

export function productFinderFields(count: number): ProcedureField[] {
  return Array.from({ length: count }, (_, index) => ({ name: `answer_${index + 1}`, validate: text(300) }));
}

export const TEMPLATES: Record<ProcedureKey, ProcedureTemplate> = {
  order_status: {
    key: "order_status", version: 1, endAction: "order_lookup", needsCapability: "lookup_orders",
    fields: [{ name: "order_number", hint: hint.order_number, validate: orderNumber }],
  },
  lead_capture: {
    key: "lead_capture", version: 1, endAction: "save_lead",
    fields: [
      { name: "name", hint: hint.name, validate: text(120) },
      { name: "contact", hint: hint.contact, validate: contact },
      { name: "product", hint: hint.product, validate: text(500) },
    ],
  },
  complaint_return: {
    // No photo field (debate verdict 11): the request carries no attachment reference, and the
    // human who takes the handoff sees any photo in the chat itself.
    key: "complaint_return", version: 1, endAction: "handoff",
    fields: [
      { name: "order_number", hint: hint.order_number, validate: orderNumber },
      { name: "problem", hint: hint.problem, validate: text(500) },
    ],
  },
  booking: {
    key: "booking", version: 1, endAction: "save_booking",
    fields: [
      { name: "service", hint: hint.service, validate: text(120) },
      { name: "when", hint: hint.when, validate: text(120) },
    ],
  },
  product_finder: {
    // Fields come from the business's 2–3 questions: productFinderFields(questions.length).
    key: "product_finder", version: 1, endAction: "product_search", needsCapability: "search_products",
    fields: [],
  },
  cod_confirm: {
    key: "cod_confirm", version: 1, endAction: "cod_update",
    fields: [{ name: "decision", validate: decision }],
  },
  review_request: {
    key: "review_request", version: 1, endAction: "review_route",
    fields: [
      { name: "rating", validate: rating },
      { name: "problem", when: (fields) => Number(fields.rating) <= 3, validate: text(500) },
    ],
  },
  back_in_stock: {
    key: "back_in_stock", version: 1, endAction: "stock_offer",
    fields: [{ name: "interest", validate: interest }],
  },
};

/** Jev intent → procedure. product_finder is deliberately absent (Spec A, D3). */
export const JEV_START: Partial<Record<Intent, ProcedureKey>> = {
  order_status: "order_status",
  lead: "lead_capture",
  complaint: "complaint_return",
  booking: "booking",
};
