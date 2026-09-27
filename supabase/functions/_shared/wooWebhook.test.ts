import { assertEquals } from "jsr:@std/assert@1";
import { classifyWooDelivery, isWooPing, verifyWooSignature } from "./wooWebhook.ts";

const NOW = new Date("2026-09-27T12:00:00Z");
const SECRET = "current-secret";
const PREVIOUS = "previous-secret";

async function mac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

Deno.test("a WooCommerce ping is the form body webhook_id and nothing else", () => {
  assertEquals(isWooPing("application/x-www-form-urlencoded", "webhook_id=42"), true);
  assertEquals(isWooPing("application/x-www-form-urlencoded", "webhook_id=42&extra=1"), false);
  assertEquals(isWooPing("application/json", "webhook_id=42"), false);
});

Deno.test("verifyWooSignature accepts the current secret and rejects a wrong or missing one", async () => {
  const body = "{\"id\":1}";
  const good = await mac(SECRET, body);
  const secrets = { current: SECRET, previous: null, rotatedAt: null };
  assertEquals(await verifyWooSignature(body, good, secrets, NOW), true);
  assertEquals(await verifyWooSignature(body, await mac("other", body), secrets, NOW), false);
  assertEquals(await verifyWooSignature(body, null, secrets, NOW), false);
});

Deno.test("a one-byte mutation of a valid signature is rejected", async () => {
  const body = "{\"id\":1}";
  const good = await mac(SECRET, body);
  const at = Math.floor(good.length / 2);
  assertEquals(good[at] === "=", false);
  const mutated = `${good.slice(0, at)}${good[at] === "A" ? "B" : "A"}${good.slice(at + 1)}`;
  assertEquals(await verifyWooSignature(body, mutated, { current: SECRET, previous: null, rotatedAt: null }, NOW), false);
});

Deno.test("the previous secret is accepted only for 24 hours after rotation", async () => {
  const body = "{\"id\":1}";
  const signature = await mac(PREVIOUS, body);
  const rotatedAt = new Date(NOW.getTime() - 24 * 60 * 60 * 1000);
  const secrets = { current: SECRET, previous: PREVIOUS, rotatedAt };
  assertEquals(await verifyWooSignature(body, signature, secrets, NOW), true);
  const expired = { ...secrets, rotatedAt: new Date(rotatedAt.getTime() - 1) };
  assertEquals(await verifyWooSignature(body, signature, expired, NOW), false);
});

const order = {
  id: 100, number: "100", status: "on-hold", total: "4.500", currency: "KWD", payment_method: "cod",
  billing: { phone: "+965 5551 2345", first_name: "Sara", email: "sara@example.com", country: "KW" },
};

Deno.test("on-hold COD becomes a cod_confirm draft with whitelist keys only", () => {
  const [draft] = classifyWooDelivery({
    topic: "order.created", body: order, now: NOW, enabled: new Set(["cod_confirm"]), reviewDelayDays: 3, country: "KW",
  });
  assertEquals(draft.flow, "cod_confirm");
  assertEquals(draft.external_id, "100");
  assertEquals(draft.payload.phone, "96555512345");
  assertEquals(draft.payload.status, "on-hold");
  assertEquals(Object.hasOwn(draft.payload, "email"), false);
  assertEquals(Object.keys(draft.payload).sort(), ["consent_basis", "currency", "first_name", "order_id", "order_number", "payment_method", "phone", "status", "total"]);
});

Deno.test("a COD order only becomes a draft when it is created, not on a later update", () => {
  assertEquals(classifyWooDelivery({
    topic: "order.updated", body: order, now: NOW, enabled: new Set(["cod_confirm"]), reviewDelayDays: 3, country: "KW",
  }), []);
});

Deno.test("a created order that is not a live COD confirmation produces no draft", () => {
  const cases = [
    ["non-COD", { ...order, payment_method: "knet" }, new Set(["cod_confirm"])],
    ["cancelled", { ...order, status: "cancelled" }, new Set(["cod_confirm"])],
    ["disabled flow", order, new Set<string>()],
  ] as const;
  for (const [label, body, enabled] of cases) {
    assertEquals(classifyWooDelivery({
      topic: "order.created", body, now: NOW, enabled, reviewDelayDays: 3, country: "KW",
    }), [], label);
  }
});

Deno.test("a review is due at completion plus the delay, and a stale completion is dropped", () => {
  const fresh = classifyWooDelivery({
    topic: "order.updated",
    body: { ...order, status: "completed", date_completed: "2026-09-26T12:00:00Z" },
    now: NOW, enabled: new Set(["review_request"]), reviewDelayDays: 3, country: "KW",
  });
  assertEquals(fresh[0]?.due_at.toISOString(), "2026-09-29T12:00:00.000Z");
  const stale = classifyWooDelivery({
    topic: "order.updated",
    body: { ...order, status: "completed", date_completed: "2026-09-20T12:00:00Z" },
    now: NOW, enabled: new Set(["review_request"]), reviewDelayDays: 3, country: "KW",
  });
  assertEquals(stale, []);
});

Deno.test("back-in-stock drafts are candidates for a matching waitlist row only", () => {
  const drafts = classifyWooDelivery({
    topic: "product.updated",
    body: { id: 9, name: "Oud", stock_status: "instock", sku: "secret-sku" },
    now: NOW, enabled: new Set(["back_in_stock"]), reviewDelayDays: 3, country: null,
    waitlist: [
      { id: "w1", product_id: 9, parent_id: null, phone: "96550001111" },
      { id: "w2", product_id: 4, parent_id: 3, phone: "96550002222" },
    ],
  });
  assertEquals(drafts.map((draft) => draft.external_id), ["waitlist:w1"]);
  assertEquals(drafts[0].payload, {
    phone: "96550001111", product_id: "9", product_name: "Oud", consent_basis: "chat_optin",
  });
  assertEquals("sku" in drafts[0].payload, false);
});

Deno.test("back-in-stock matches the reported product or its parent, never a child row of the reported product", () => {
  const base = {
    now: NOW, enabled: new Set(["back_in_stock"]), reviewDelayDays: 3, country: null,
  };
  const child = { id: "child", product_id: 42, parent_id: 9, phone: "96555510042" };
  const parentRow = { id: "parent", product_id: 9, parent_id: null, phone: "96555510009" };

  const parentUpdate = classifyWooDelivery({
    topic: "product.updated",
    body: { id: 9, name: "Oud", stock_status: "instock" },
    ...base,
    waitlist: [child, parentRow],
  });
  assertEquals(parentUpdate.map((draft) => draft.external_id), ["waitlist:parent"]);
  assertEquals(parentUpdate[0].payload.product_id, "9");

  const variationUpdate = classifyWooDelivery({
    topic: "product.updated",
    body: { id: 42, parent_id: 9, name: "Oud 50ml", stock_status: "instock" },
    ...base,
    waitlist: [child, parentRow],
  });
  assertEquals(variationUpdate.map((draft) => draft.external_id), ["waitlist:child", "waitlist:parent"]);
  assertEquals(variationUpdate[0].payload.product_id, "42");
  assertEquals(variationUpdate[1].payload.product_id, "9");
  assertEquals(variationUpdate[1].payload.product_name, "Oud 50ml");
});


