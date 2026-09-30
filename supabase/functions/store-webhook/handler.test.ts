import { assert, assertEquals } from "jsr:@std/assert@1";
import { enabledStoreFlows, handleStoreWebhook, type ScopedWaitlistRow, type StoreBinding, type StoreWebhookDeps } from "./handler.ts";

const BINDING_ID = "11111111-1111-4111-8111-111111111111";
const URL = `https://api.example/functions/v1/store-webhook/${BINDING_ID}`;
const NOW = new Date("2026-09-27T12:00:00Z");
const SECRET = "current-secret";

async function mac(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const bytes = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)));
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

const ORDER = JSON.stringify({
  id: 100, number: "100", status: "processing", total: "4.500", currency: "KWD", payment_method: "cod",
  billing: { phone: "+965 5551 2345", first_name: "Sara", country: "KW" },
});

function deps(extra: Partial<StoreWebhookDeps> = {}): StoreWebhookDeps & { connectorChecks: number; inserted: Array<Record<string, unknown>>; ignored: string[] } {
  const inserted: Array<Record<string, unknown>> = [];
  const base: StoreWebhookDeps & { connectorChecks: number; inserted: Array<Record<string, unknown>>; ignored: string[] } = {
    connectorChecks: 0,
    inserted,
    limitIp: async () => ({ allowed: true }),
    limitConnector: async () => { base.connectorChecks += 1; return { allowed: true }; },
    loadBinding: async () => ({ id: BINDING_ID, user_id: "user-1", social_account_id: "acc-1", connector_id: "con-1" }),
    loadSecrets: async () => ({ current: SECRET, previous: null, rotatedAt: null }),
    loadProcedures: async () => ({}),
    loadWaitlist: async () => [],
    insertEvents: async (rows) => { inserted.push(...rows); return { ok: true, stored: rows.length }; },
    logIgnored: async (entry) => { base.ignored.push(entry.reason); },
    ignored: [],
    now: () => NOW,
  };
  return Object.assign(base, extra);
}

Deno.test("a ping is acknowledged before the binding is loaded", async () => {
  const gate = deps({ loadBinding: async () => { throw new Error("should not load"); } });
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: "webhook_id=7",
  }), gate);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true });
});

Deno.test("the IP limit runs before the body is read", async () => {
  const order: string[] = [];
  const stream = new ReadableStream({
    pull(controller) {
      order.push("body");
      controller.enqueue(new TextEncoder().encode("webhook_id=1"));
      controller.close();
    },
  }, { highWaterMark: 0 }); // pull only when the handler reads
  const response = await handleStoreWebhook(new Request(URL, { method: "POST", body: stream }), deps({
    limitIp: async () => { order.push("limit"); return { allowed: false, retryAfter: 9 }; },
  }));
  assertEquals(response.status, 429);
  assertEquals(order, ["limit"]);
});

Deno.test("a declared body over 256 KiB is refused before it is read", async () => {
  let read = false;
  const stream = new ReadableStream({
    pull(controller) {
      read = true;
      controller.close();
    },
  }, { highWaterMark: 0 });
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: { "content-length": String(262145) },
    body: stream,
  }), deps());
  assertEquals(response.status, 413);
  assertEquals(read, false);
});

Deno.test("a stream that exceeds the cap is refused", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(262145));
      controller.close();
    },
  });
  const response = await handleStoreWebhook(new Request("https://api.example/functions/v1/store-webhook/" + BINDING_ID, {
    method: "POST",
    body: stream,
  }), deps());
  assertEquals(response.status, 413);
});

function accepting(extra: Partial<StoreWebhookDeps> = {}) {
  return deps({
    flowsFrom: () => new Set(["cod_confirm"]),
    loadProcedures: async () => ({ cod_confirm: { enabled: true } }),
    ...extra,
  });
}

function jsonPost(body: string, signature: string | null, topic = "order.created"): Request {
  const headers: Record<string, string> = { "content-type": "application/json", "x-wc-webhook-topic": topic };
  if (signature !== null) headers["x-wc-webhook-signature"] = signature;
  return new Request(URL, { method: "POST", headers, body });
}

Deno.test("a good signature is stored", async () => {
  const good = accepting();
  const ok = await handleStoreWebhook(jsonPost(ORDER, await mac(SECRET, ORDER)), good);
  assertEquals(ok.status, 200);
  assertEquals(await ok.json(), { ok: true, stored: 1 });
  assertEquals(good.inserted.length, 1);
  assertEquals(good.inserted[0].payload, {
    order_id: "100", order_number: "100", phone: "96555512345", first_name: "Sara",
    total: "4.500", currency: "KWD", status: "processing", payment_method: "cod", consent_basis: "checkout",
  });
  assert(!JSON.stringify(good.inserted[0]).includes("current-secret"));
});

Deno.test("a wrong signature is 401 and does not spend the connector limit", async () => {
  const wrong = deps();
  const denied = await handleStoreWebhook(jsonPost(ORDER, "aaaa"), wrong);
  assertEquals(denied.status, 401);
  assertEquals(wrong.connectorChecks, 0);
  assertEquals(wrong.inserted, []);
  assertEquals(await denied.json(), { error: "unauthorized" });
});

Deno.test("a missing signature is 401 and does not spend the connector limit", async () => {
  const gate = deps();
  const missing = await handleStoreWebhook(jsonPost(ORDER, null), gate);
  assertEquals(missing.status, 401);
  assertEquals(gate.connectorChecks, 0);
  assertEquals(gate.inserted, []);
});

const RAW_ORDER = [
  "{",
  '  "billing" : { "country" : "KW", "first_name" : "Sara", "phone" : "+965 5551 2345" },',
  '  "currency" : "KWD",',
  '  "id" : 100,',
  '  "number" : "100",',
  '  "payment_method" : "cod",',
  '  "status" : "processing",',
  '  "total" : "4.500"',
  "}",
].join("\n");

Deno.test("a body with whitespace and reordered keys is stored when signed exactly as sent", async () => {
  const gate = accepting();
  const response = await handleStoreWebhook(jsonPost(RAW_ORDER, await mac(SECRET, RAW_ORDER)), gate);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { ok: true, stored: 1 });
  assertEquals(gate.inserted.length, 1);
  assertEquals((gate.inserted[0].payload as { phone: string }).phone, "96555512345");
});

Deno.test("a body signed and then changed by one byte is 401 and is not stored", async () => {
  const signature = await mac(SECRET, RAW_ORDER);
  const at = RAW_ORDER.indexOf("processing");
  const mutated = `${RAW_ORDER.slice(0, at)}X${RAW_ORDER.slice(at + 1)}`;
  const gate = accepting();
  const response = await handleStoreWebhook(jsonPost(mutated, signature), gate);
  assertEquals(response.status, 401);
  assertEquals(gate.inserted, []);
});

const PREVIOUS = "previous-secret";
const DAY_MS = 24 * 60 * 60 * 1000;

function secretsAt(rotatedAt: string) {
  return accepting({
    loadSecrets: async () => ({ current: SECRET, previous: PREVIOUS, rotatedAt }),
  });
}

Deno.test("a delivery signed with the previous secret inside 24 hours is stored", async () => {
  const gate = secretsAt(new Date(NOW.getTime() - (DAY_MS - 1)).toISOString());
  const response = await handleStoreWebhook(jsonPost(ORDER, await mac(PREVIOUS, ORDER)), gate);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).stored, 1);
  assertEquals(gate.inserted.length, 1);
});

Deno.test("a delivery signed with the previous secret at 24 hours plus 1ms is 401", async () => {
  const gate = secretsAt(new Date(NOW.getTime() - (DAY_MS + 1)).toISOString());
  const response = await handleStoreWebhook(jsonPost(ORDER, await mac(PREVIOUS, ORDER)), gate);
  assertEquals(response.status, 401);
  assertEquals(gate.inserted, []);
});

Deno.test("a previous secret whose rotation time is in the future is refused", async () => {
  const gate = secretsAt(new Date(NOW.getTime() + 1).toISOString());
  const response = await handleStoreWebhook(jsonPost(ORDER, await mac(PREVIOUS, ORDER)), gate);
  assertEquals(response.status, 401);
  assertEquals(gate.inserted, []);
});

Deno.test("a connector rate limit denial is 429 and stores nothing", async () => {
  const gate = accepting({ limitConnector: async () => ({ allowed: false, retryAfter: 9 }) });
  const response = await handleStoreWebhook(jsonPost(ORDER, await mac(SECRET, ORDER)), gate);
  assertEquals(response.status, 429);
  assertEquals(gate.inserted, []);
});

Deno.test("a loadBinding failure is 500", async () => {
  const gate = deps({ loadBinding: async () => { throw new Error("db down"); } });
  const response = await handleStoreWebhook(jsonPost("{}", await mac(SECRET, "{}")), gate);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "store_failed" });
  assertEquals(gate.inserted, []);
});

Deno.test("a loadSecrets failure is 500", async () => {
  const gate = deps({ loadSecrets: async () => { throw new Error("vault down"); } });
  const response = await handleStoreWebhook(jsonPost("{}", await mac(SECRET, "{}")), gate);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "store_failed" });
  assertEquals(gate.inserted, []);
});

Deno.test("missing webhook secrets are 401", async () => {
  const gate = deps({ loadSecrets: async () => null });
  const response = await handleStoreWebhook(jsonPost("{}", await mac(SECRET, "{}")), gate);
  assertEquals(response.status, 401);
  assertEquals(await response.json(), { error: "unauthorized" });
  assertEquals(gate.inserted, []);
});

Deno.test("an event flow without its required consent is not stored", async () => {
  const gate = deps({
    loadProcedures: async () => ({ cod_confirm: { enabled: true, prompts: {}, closing: "" } }),
  });
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-signature": await mac(SECRET, ORDER),
      "x-wc-webhook-topic": "order.created",
    },
    body: ORDER,
  }), gate);
  assertEquals(await response.json(), { ok: true, stored: 0, ignored: "cod_confirm_not_active" });
  assertEquals(gate.inserted, []);
  assertEquals(enabledStoreFlows({ cod_confirm: { enabled: true, prompts: {}, closing: "" } }).size, 0);
});

Deno.test("review_request delay_days comes from the account config", async () => {
  const completed = JSON.stringify({
    id: 100, number: "100", status: "completed", total: "4.500", currency: "KWD", payment_method: "cod",
    date_completed: "2026-09-20T12:00:00Z",
    billing: { phone: "+965 5551 2345", first_name: "Sara", country: "KW" },
  });
  const gate = deps({
    loadProcedures: async () => ({
      review_request: {
        enabled: true, prompts: {}, closing: "", consent_attested_at: "2026-09-01T00:00:00Z",
        delay_days: 7, review_url: "https://shop.example/reviews",
      },
    }),
  });
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-signature": await mac(SECRET, completed),
      "x-wc-webhook-topic": "order.updated",
    },
    body: completed,
  }), gate);
  assertEquals(await response.json(), { ok: true, stored: 1 });
  assertEquals(gate.inserted[0].due_at, "2026-09-27T12:00:00.000Z");
  assertEquals(gate.inserted[0].flow, "review_request");
});

Deno.test("an insert failure is 500 and the response does not echo the delivery", async () => {
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-signature": await mac(SECRET, ORDER),
      "x-wc-webhook-topic": "order.created",
    },
    body: ORDER,
  }), deps({
    flowsFrom: () => new Set(["cod_confirm"]),
    insertEvents: async () => ({ ok: false }),
  }));
  assertEquals(response.status, 500);
  const text = await response.text();
  assertEquals(text, JSON.stringify({ error: "store_failed" }));
  assert(!text.includes("5551"));
  assert(!text.includes(ORDER));
});

Deno.test("a duplicate delivery stores once", async () => {
  const seen = new Set<string>();
  const rows: Array<Record<string, unknown>> = [];
  const gate = deps({
    flowsFrom: () => new Set(["cod_confirm"]),
    insertEvents: async (batch) => {
      let stored = 0;
      for (const row of batch) {
        const key = `${row.binding_id}:${row.flow}:${row.external_id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push(row);
        stored += 1;
      }
      return { ok: true, stored };
    },
  });
  const signature = await mac(SECRET, ORDER);
  const call = () => handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wc-webhook-signature": signature,
      "x-wc-webhook-topic": "order.created",
    },
    body: ORDER,
  }), gate);
  assertEquals((await (await call()).json()).stored, 1);
  assertEquals((await (await call()).json()).stored, 0);
  assertEquals(rows.length, 1);
});

Deno.test("an unknown binding is a detail-free 404", async () => {
  const missing = await handleStoreWebhook(jsonPost("{}", await mac(SECRET, "{}")), deps({ loadBinding: async () => null }));
  assertEquals(missing.status, 404);
  assertEquals(await missing.json(), { error: "not_found" });
});

Deno.test("broken JSON is 400", async () => {
  const broken = await handleStoreWebhook(jsonPost("{", await mac(SECRET, "{")), deps());
  assertEquals(broken.status, 400);
  assertEquals(await broken.json(), { error: "invalid_json" });
});

Deno.test("another account's waitlist rows on the same connector never produce drafts", async () => {
  const product = JSON.stringify({ id: 9, name: "Oud", stock_status: "instock" });
  const seen: StoreBinding[] = [];
  const rows: ScopedWaitlistRow[] = [
    { id: "mine", product_id: 9, parent_id: null, phone: "96550001111", connector_id: "con-1", social_account_id: "acc-1" },
    { id: "theirs", product_id: 9, parent_id: null, phone: "96550002222", connector_id: "con-1", social_account_id: "acc-2" },
  ];
  const gate = accepting({
    flowsFrom: () => new Set(["back_in_stock"]),
    loadWaitlist: async (binding) => {
      seen.push(binding);
      return rows;
    },
  });
  const response = await handleStoreWebhook(jsonPost(product, await mac(SECRET, product), "product.updated"), gate);
  assertEquals(response.status, 200);
  assertEquals(seen.map((binding) => binding.social_account_id), ["acc-1"]);
  assertEquals(seen.map((binding) => binding.connector_id), ["con-1"]);
  assertEquals(gate.inserted.map((row) => row.external_id), ["waitlist:mine"]);
  assertEquals(JSON.stringify(gate.inserted).includes("96550002222"), false);
});

Deno.test("only POST is accepted", async () => {
  const response = await handleStoreWebhook(new Request(URL, { method: "GET" }), deps());
  assertEquals(response.status, 405);
});

Deno.test("the waitlist is read for the product and parent ids only, and non-integer ids never reach the filter", async () => {
  const asked: number[][] = [];
  const gate = accepting({
    flowsFrom: () => new Set(["back_in_stock"]),
    loadWaitlist: async (_binding, productIds) => {
      asked.push(productIds);
      return [];
    },
  });
  for (const body of [
    { id: 42, stock_status: "instock" },
    { id: 43, parent_id: 9, stock_status: "instock" },
    { id: 44, parent_id: "9),id.gt.(0", stock_status: "instock" },
    { id: "1,parent_id.gt.0", stock_status: "instock" },
  ]) {
    const raw = JSON.stringify(body);
    assertEquals((await handleStoreWebhook(jsonPost(raw, await mac(SECRET, raw), "product.updated"), gate)).status, 200);
  }
  assertEquals(asked, [[42], [43, 9], [44]]);
});

Deno.test("a variation update reaches a customer waiting on its parent product", async () => {
  const gate = accepting({
    flowsFrom: () => new Set(["back_in_stock"]),
    loadWaitlist: async () => [
      { id: "w1", product_id: 9, parent_id: null, phone: "96550001111", connector_id: "con-1", social_account_id: "acc-1" },
    ],
  });
  const raw = JSON.stringify({ id: 42, parent_id: 9, name: "Oud 50ml", stock_status: "instock" });
  assertEquals((await handleStoreWebhook(jsonPost(raw, await mac(SECRET, raw), "product.updated"), gate)).status, 200);
  assertEquals(gate.inserted.map((row) => row.external_id), ["waitlist:w1"]);
});

Deno.test("an order.created the COD flow cannot start is logged with its reason and echoed to WooCommerce", async () => {
  const cases: Array<{ name: string; body: Record<string, unknown>; enabled: string[]; reason: string }> = [
    { name: "flow off", body: JSON.parse(ORDER), enabled: [], reason: "cod_confirm_not_active" },
    { name: "card payment", body: { ...JSON.parse(ORDER), payment_method: "myfatoorah_v2" }, enabled: ["cod_confirm"], reason: "not_cash_on_delivery" },
    { name: "cancelled", body: { ...JSON.parse(ORDER), status: "cancelled" }, enabled: ["cod_confirm"], reason: "order_status_not_eligible" },
    { name: "no country", body: { ...JSON.parse(ORDER), billing: { phone: "66106604", first_name: "Sara" } }, enabled: ["cod_confirm"], reason: "customer_phone_unrecognised" },
  ];
  for (const testCase of cases) {
    const body = JSON.stringify(testCase.body);
    const gate = deps({ flowsFrom: () => new Set(testCase.enabled) });
    const response = await handleStoreWebhook(new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-topic": "order.created", "x-wc-webhook-signature": await mac(SECRET, body) },
      body,
    }), gate);
    assertEquals(await response.json(), { ok: true, stored: 0, ignored: testCase.reason }, testCase.name);
    assertEquals(gate.ignored, [testCase.reason], testCase.name);
  }
});

Deno.test("a routine order update is not logged as ignored", async () => {
  const body = ORDER;
  const gate = deps({ flowsFrom: () => new Set(["cod_confirm"]) });
  const response = await handleStoreWebhook(new Request(URL, {
    method: "POST",
    headers: { "content-type": "application/json", "x-wc-webhook-topic": "order.updated", "x-wc-webhook-signature": await mac(SECRET, body) },
    body,
  }), gate);
  assertEquals(await response.json(), { ok: true, stored: 0 });
  assertEquals(gate.ignored, []);
});

Deno.test("an authentic delivery whose body is not a JSON object is refused and logged", async () => {
  for (const body of ["[1,2]", "null", "not json"]) {
    const gate = deps();
    const response = await handleStoreWebhook(new Request(URL, {
      method: "POST",
      headers: { "content-type": "application/json", "x-wc-webhook-topic": "order.created", "x-wc-webhook-signature": await mac(SECRET, body) },
      body,
    }), gate);
    assertEquals(response.status, 400, body);
    assertEquals(gate.ignored, ["invalid_json"], body);
  }
});
