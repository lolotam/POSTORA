// Opener wording for store-event flows. The Cloud API templates use the same
// sentences; QR sends this text as a free-form message.
import type { EventProcedureKey } from "./templates.ts";

export type OpenerLanguage = "ar" | "en";

export const OPENER_BODIES: Record<EventProcedureKey, Record<OpenerLanguage, string>> = {
  cod_confirm: {
    ar: "مرحباً {{1}}، طلبك رقم {{2}} بمبلغ {{3}} ينتظر تأكيد الدفع عند الاستلام.",
    en: "Hello {{1}}, your order {{2}} for {{3}} is waiting for cash-on-delivery confirmation.",
  },
  review_request: {
    ar: "مرحباً {{1}}، اكتمل طلبك رقم {{2}}. كيف تقيّم تجربتك من 1 إلى 5؟",
    en: "Hello {{1}}, your order {{2}} is complete. How would you rate the experience from 1 to 5?",
  },
  back_in_stock: {
    ar: "مرحباً {{1}}، {{2}} رجع للمخزون. تحب نكمّل الطلب؟",
    en: "Hello {{1}}, {{2}} is back in stock. Would you like to order it?",
  },
};

export const COD_BUTTONS: Record<OpenerLanguage, readonly [string, string]> = {
  ar: ["تأكيد", "إلغاء"],
  en: ["Confirm", "Cancel"],
};

const FALLBACK_NAME: Record<OpenerLanguage, string> = { ar: "عميل", en: "there" };

function filled(value: string | undefined, fallback: string): string {
  const text = (value ?? "").replace(/[\r\n]+/g, " ").trim();
  return text || fallback;
}

/** Body parameters in {{n}} order. Blank name becomes a single safe word so Meta accepts the variable. */
export function openerValues(
  flow: EventProcedureKey,
  language: OpenerLanguage,
  payload: Record<string, string>,
): string[] {
  const name = filled(payload.first_name, FALLBACK_NAME[language]);
  if (flow === "back_in_stock") return [name, filled(payload.product_name, "—")];
  const total = filled(`${payload.total ?? ""} ${payload.currency ?? ""}`.trim(), "—");
  const orderNumber = filled(payload.order_number ?? payload.order_id, "—");
  if (flow === "review_request") return [name, orderNumber];
  return [name, orderNumber, total];
}

export function openerText(
  flow: EventProcedureKey,
  language: OpenerLanguage,
  payload: Record<string, string>,
): string {
  const values = openerValues(flow, language, payload);
  return OPENER_BODIES[flow][language].replace(/\{\{(\d+)\}\}/g, (_, index: string) => values[Number(index) - 1] ?? "");
}

export function openerLanguage(languageMode: unknown): OpenerLanguage {
  return languageMode === "en" ? "en" : "ar";
}
