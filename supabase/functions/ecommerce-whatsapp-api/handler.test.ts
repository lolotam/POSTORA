import { assertEquals } from "jsr:@std/assert@1";
import { handleEcommerceWhatsApp, type EcommerceDeps } from "./handler.ts";

const USER = "user-1";
const TO = "96550001111";

function deps(extra: Partial<EcommerceDeps> = {}) {
  const gate = {
    text: 0,
    media: 0,
    graph: 0,
    logs: [] as Array<{ reason: string; metadata: Record<string, unknown> }>,
    lookupUser: async () => ({ id: USER }),
    recentPostCount: async () => 0,
    insertApiLog: async () => {},
    loadHealth: async () => null,
    loadSendAccount: async () => ({
      id: "acc-1",
      platform_user_id: "pnid",
      access_token: "cloud-token",
      connection_mode: "cloud_api",
    }),
    optedOutPhones: async () => new Set([TO]),
    logSendRefused: async (input: { reason: string; metadata: Record<string, unknown> }) => {
      gate.logs.push({ reason: input.reason, metadata: input.metadata });
    },
    sendText: async () => { gate.text += 1; return { messages: [{ id: "t" }] }; },
    sendMedia: async () => { gate.media += 1; return { messages: [{ id: "m" }] }; },
    postGraph: async () => { gate.graph += 1; return { ok: true, data: { messages: [{ id: "g" }] } }; },
    insertMessage: async () => {},
    now: () => Date.parse("2026-09-27T12:00:00Z"),
  };
  return Object.assign(gate, extra);
}

function post(body: Record<string, unknown>): Request {
  return new Request("https://api.example/ecommerce-whatsapp-api", {
    method: "POST",
    headers: { "x-api-key": "store-key" },
    body: JSON.stringify(body),
  });
}

for (const [action, body] of [
  ["send_text", { action: "send_text", to: `+${TO}`, text: "hello" }],
  ["send_template", { action: "send_template", to: TO, template_name: "order_confirmation_v1" }],
  ["send_media", { action: "send_media", to: TO, media_url: "https://cdn.example/a.jpg", media_type: "image" }],
  ["event", { action: "event", to: TO, event: "order.created", data: { customer_name: "Sara", order_number: "100" } }],
] as const) {
  Deno.test(`ecommerce ${action} to an opted-out number does not call the provider`, async () => {
    const gate = deps();
    const response = await handleEcommerceWhatsApp(post({ ...body, user_id: "other-user" }), gate);
    assertEquals(response.status, 200);
    assertEquals(response.headers.get("X-RateLimit-Limit"), "60");
    assertEquals(await response.json(), {
      success: false,
      error_code: "RECIPIENT_OPTED_OUT",
      error: "This customer has opted out of WhatsApp messages",
    });
    assertEquals(gate.text, 0);
    assertEquals(gate.media, 0);
    assertEquals(gate.graph, 0);
    assertEquals(gate.logs, [{ reason: "opted_out", metadata: { action } }]);
  });
}

Deno.test("ecommerce opt-out lookup failure returns 500 and does not send", async () => {
  const gate = deps({
    optedOutPhones: async () => { throw new Error("opt_out_lookup_failed"); },
  });
  const response = await handleEcommerceWhatsApp(post({ action: "send_text", to: TO, text: "hello" }), gate);
  assertEquals(response.status, 500);
  assertEquals(response.headers.get("X-RateLimit-Remaining"), "59");
  assertEquals(await response.json(), { success: false, error_code: "OPT_OUT_LOOKUP_FAILED" });
  assertEquals(gate.text + gate.media + gate.graph, 0);
  assertEquals(gate.logs[0]?.reason, "opt_out_lookup_failed");
  assertEquals(JSON.stringify(gate.logs).includes(TO), false);
});

Deno.test("ecommerce GET health does not look up opt-outs", async () => {
  let lookups = 0;
  const gate = deps({
    loadHealth: async () => ({ id: "acc-1", platform_user_id: "pnid", access_token: null, connection_mode: "cloud_api", platform_username: "shop" }),
    optedOutPhones: async () => { lookups += 1; return new Set<string>(); },
  });
  const response = await handleEcommerceWhatsApp(new Request("https://api.example/ecommerce-whatsapp-api", {
    method: "GET",
    headers: { "x-api-key": "store-key" },
  }), gate);
  assertEquals(response.status, 200);
  assertEquals((await response.json()).whatsapp_connected, true);
  assertEquals(lookups, 0);
});
