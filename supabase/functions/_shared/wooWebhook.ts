// Pure WooCommerce delivery checks. The handler owns I/O; nothing here reads or logs a body.
import { parseCustomerPhone } from "./phone.ts";

const COD_STATUSES = new Set(["pending", "on-hold", "processing"]);
const PAYLOAD_KEYS = [
  "order_id", "order_number", "phone", "first_name", "total", "currency", "status",
  "payment_method", "date_completed", "product_id", "parent_id", "product_name", "consent_basis",
] as const;
const REVIEW_STALE_MS = 48 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export function isWooPing(contentType: string | null, rawBody: string): boolean {
  if (contentType && !contentType.includes("application/x-www-form-urlencoded") && !contentType.includes("text/plain")) {
    return false;
  }
  return /^webhook_id=\d+$/.test(rawBody);
}

export async function verifyWooSignature(
  rawBody: string,
  signature: string | null,
  secrets: { current: string; previous: string | null; rotatedAt: Date | null },
  now: Date,
): Promise<boolean> {
  if (!signature) return false;
  const presented = signature.trim();
  if (await signed(rawBody, secrets.current, presented)) return true;
  if (!secrets.previous || !secrets.rotatedAt) return false;
  const age = now.getTime() - secrets.rotatedAt.getTime();
  if (age < 0 || age > 24 * 60 * 60 * 1000) return false;
  return signed(rawBody, secrets.previous, presented);
}

async function signed(rawBody: string, secret: string, presented: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rawBody)));
  return timingSafeEqual(presented, base64(mac));
}

function base64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Compare the whole signature even when a prefix already differs. */
function timingSafeEqual(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length, 1);
  let diff = left.length === right.length ? 0 : 1;
  for (let i = 0; i < length; i++) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

export type EventDraft = {
  flow: "cod_confirm" | "review_request" | "back_in_stock";
  external_id: string;
  due_at: Date;
  payload: Record<string, string>;
};

/** One un-notified waitlist row the product update may match. `phone` is copied into the event payload. */
export interface WaitlistMatch {
  id: string;
  product_id: number;
  parent_id: number | null;
  phone: string;
}

export function classifyWooDelivery(input: {
  topic: string | null;
  body: unknown;
  now: Date;
  enabled: ReadonlySet<string>;
  reviewDelayDays: number;
  country: string | null;
  waitlist?: WaitlistMatch[];
}): EventDraft[] {
  if (!input.topic || typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) return [];
  const body = input.body as Record<string, unknown>;
  const drafts: EventDraft[] = [];
  if (input.topic === "order.created" || input.topic === "order.updated") {
    const order = orderPayload(body, input.country);
    if (order && input.topic === "order.created" && input.enabled.has("cod_confirm") && isCod(body)) {
      drafts.push({ flow: "cod_confirm", external_id: order.order_id, due_at: input.now, payload: order });
    }
    if (order && input.topic === "order.updated" && input.enabled.has("review_request") && body.status === "completed") {
      const due = reviewDue(body.date_completed, input.reviewDelayDays);
      if (due && input.now.getTime() - due.getTime() <= REVIEW_STALE_MS) {
        drafts.push({
          flow: "review_request",
          external_id: order.order_id,
          due_at: due,
          payload: { ...order, ...(typeof body.date_completed === "string" ? { date_completed: body.date_completed } : {}) },
        });
      }
    }
  }
  if (input.topic === "product.updated" && input.enabled.has("back_in_stock") && body.stock_status === "instock") {
    drafts.push(...stockDrafts(body, input.waitlist ?? [], input.now));
  }
  return drafts;
}

/**
 * Why a delivery that could have started a flow produced no event ("not_active"
 * covers a flow switched off or missing its consent / QR acknowledgement). Null for
 * routine traffic (an order update that is not a completion, product updates)
 * so the log only carries deliveries a merchant would expect to act on.
 */
export function ignoredDeliveryReason(input: Parameters<typeof classifyWooDelivery>[0]): string | null {
  if (!input.topic) return "missing_topic";
  if (typeof input.body !== "object" || input.body === null || Array.isArray(input.body)) return "invalid_body";
  const body = input.body as Record<string, unknown>;
  if (input.topic === "order.created") {
    if (!input.enabled.has("cod_confirm")) return "cod_confirm_not_active";
    if (String(body.payment_method ?? "").toLowerCase() !== "cod") return "not_cash_on_delivery";
    if (!COD_STATUSES.has(String(body.status ?? ""))) return "order_status_not_eligible";
    if (!orderPayload(body, input.country)) return "customer_phone_unrecognised";
    return null;
  }
  if (input.topic === "order.updated") {
    if (body.status !== "completed") return null;
    if (!input.enabled.has("review_request")) return "review_request_not_active";
    if (!orderPayload(body, input.country)) return "customer_phone_unrecognised";
    return "review_not_due";
  }
  if (input.topic === "product.updated") return null;
  return "topic_not_handled";
}

function isCod(body: Record<string, unknown>): boolean {
  return String(body.payment_method ?? "").toLowerCase() === "cod" && COD_STATUSES.has(String(body.status ?? ""));
}

function orderPayload(body: Record<string, unknown>, country: string | null): Record<string, string> | null {
  const billing = asRecord(body.billing);
  const billingCountry = typeof billing.country === "string" ? billing.country : country;
  const phone = parseCustomerPhone(typeof billing.phone === "string" ? billing.phone : "", billingCountry);
  const orderId = scalar(body.id);
  if (!phone || !orderId) return null;
  return whitelist({
    order_id: orderId,
    order_number: scalar(body.number) ?? orderId,
    phone,
    first_name: typeof billing.first_name === "string" ? billing.first_name.trim() : "",
    total: scalar(body.total) ?? "",
    currency: scalar(body.currency) ?? "",
    status: scalar(body.status) ?? "",
    payment_method: scalar(body.payment_method) ?? "",
    consent_basis: "checkout",
  });
}

function reviewDue(value: unknown, delayDays: number): Date | null {
  if (typeof value !== "string") return null;
  const completed = Date.parse(value);
  if (!Number.isFinite(completed)) return null;
  return new Date(completed + delayDays * DAY_MS);
}

function stockDrafts(
  body: Record<string, unknown>,
  waitlist: WaitlistMatch[],
  now: Date,
): EventDraft[] {
  const id = Number(body.id);
  if (!Number.isInteger(id)) return [];
  const parent = body.parent_id == null || body.parent_id === "" ? null : Number(body.parent_id);
  const name = typeof body.name === "string" ? body.name : "";
  const drafts: EventDraft[] = [];
  for (const row of waitlist) {
    // X matches the waited-on product. P matches a parent-level row when a variation of it
    // came back. A child row whose parent_id is X stays untouched: drafting it would tombstone
    // the variation the customer actually waited for.
    const hit = row.product_id === id || (parent != null && row.product_id === parent);
    if (!hit) continue;
    drafts.push({
      flow: "back_in_stock",
      // One waitlist row is one customer. An exact update and a variation update that both
      // name that product share this id.
      external_id: `waitlist:${row.id}`,
      due_at: now,
      payload: whitelist({
        phone: row.phone,
        product_id: String(row.product_id),
        parent_id: row.parent_id == null ? "" : String(row.parent_id),
        product_name: name,
        consent_basis: "chat_optin",
      }),
    });
  }
  return drafts;
}

function whitelist(entries: Record<string, string>): Record<string, string> {
  const payload: Record<string, string> = {};
  for (const key of PAYLOAD_KEYS) {
    const value = entries[key];
    if (value) payload[key] = value;
  }
  return payload;
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function scalar(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "string" && value.trim()) return value.trim();
  return null;
}
