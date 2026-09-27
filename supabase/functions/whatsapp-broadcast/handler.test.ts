import { assertEquals } from "jsr:@std/assert@1";
import { handleWhatsAppBroadcast, type BroadcastDeps, type BroadcastRecipient } from "./handler.ts";

const USER = "user-1";
const PHONE = "+965 5000-1111";
const OTHER = "96550002222";

function recipient(id: string, phone_number: string): BroadcastRecipient {
  return { id, phone_number };
}

function deps(extra: Partial<BroadcastDeps> = {}) {
  const gate = {
    graph: 0,
    sending: 0,
    lookups: [] as Array<{ userId: string; phones: string[] }>,
    logs: [] as Array<{ reason: string; metadata: Record<string, unknown> }>,
    skipped: [] as string[][],
    authenticate: async () => ({ userId: USER }),
    loadBroadcast: async () => ({
      id: "b1", status: "pending", name: "Promo", template_name: "hello",
      template_components: { language: "en_US" }, sent_count: 0, failed_count: 0,
    }),
    loadWhatsAppAccounts: async () => [{ access_token: "cloud-token", platform_user_id: "phone-number-id", account_metadata: {} }],
    loadPendingRecipients: async () => [recipient("r1", PHONE), recipient("r2", OTHER)],
    markSending: async () => { gate.sending += 1; },
    skipRecipients: async (_broadcastId: string, ids: string[]) => { gate.skipped.push(ids); },
    markRecipientSent: async () => {},
    markRecipientFailed: async () => {},
    insertOutbound: async () => {},
    finish: async () => {},
    optedOutPhones: async (userId: string, phones: string[]) => {
      gate.lookups.push({ userId, phones });
      return new Set<string>();
    },
    logSendRefused: async (input: { reason: string; metadata: Record<string, unknown> }) => {
      gate.logs.push({ reason: input.reason, metadata: input.metadata });
    },
    postTemplate: async () => {
      gate.graph += 1;
      return { ok: true, data: { messages: [{ id: "wamid" }] } };
    },
    sleep: async () => {},
  };
  return Object.assign(gate, extra);
}

function request(body: Record<string, unknown> = { broadcast_id: "b1" }): Request {
  return new Request("https://api.example/whatsapp-broadcast", { method: "POST", body: JSON.stringify(body) });
}

Deno.test("broadcast lookup failure returns 500, sends nothing, and does not mark the broadcast sending", async () => {
  const gate = deps({
    optedOutPhones: async (userId, phones) => {
      gate.lookups.push({ userId, phones });
      throw new Error("opt_out_lookup_failed");
    },
  });
  const response = await handleWhatsAppBroadcast(request({ broadcast_id: "b1", user_id: "someone-else" }), gate);
  assertEquals(response.status, 500);
  assertEquals(await response.json(), { error: "opt_out_lookup_failed" });
  assertEquals(gate.graph, 0);
  assertEquals(gate.sending, 0);
  assertEquals(gate.lookups, [{ userId: USER, phones: [PHONE, OTHER] }]);
  assertEquals(gate.logs[0]?.reason, "opt_out_lookup_failed");
  assertEquals(JSON.stringify(gate.logs).includes("50001111"), false);
});

Deno.test("broadcast skip-write failure returns 500 before any send", async () => {
  const gate = deps({
    loadPendingRecipients: async () => [recipient("r1", PHONE)],
    optedOutPhones: async () => new Set(["96550001111"]),
    skipRecipients: async () => { throw new Error("opt_out_skip_failed"); },
  });
  const response = await handleWhatsAppBroadcast(request(), gate);
  assertEquals(response.status, 500);
  assertEquals(gate.graph, 0);
  assertEquals(gate.sending, 0);
  assertEquals(gate.logs.map((log) => log.reason), ["opt_out_skip_failed"]);
});

Deno.test("a mixed broadcast sends only the numbers that are not opted out", async () => {
  const sent: string[] = [];
  const gate = deps({
    optedOutPhones: async () => new Set(["96550001111"]),
    postTemplate: async (_phoneNumberId, _token, body) => {
      gate.graph += 1;
      sent.push(String(body.to));
      return { ok: true, data: { messages: [{ id: "wamid" }] } };
    },
  });
  const response = await handleWhatsAppBroadcast(request(), gate);
  assertEquals(response.status, 200);
  assertEquals(await response.json(), { success: true, sent: 1, failed: 0, skipped: 1, status: "completed" });
  assertEquals(sent, [OTHER]);
  assertEquals(gate.skipped, [["r1"]]);
  assertEquals(gate.logs[0], { reason: "opted_out", metadata: { broadcast_id: "b1", skipped_count: 1 } });
});

Deno.test("a broadcast whose whole batch opted out completes with nothing sent", async () => {
  const gate = deps({
    loadPendingRecipients: async () => [recipient("r1", PHONE), recipient("r2", "+965 5000-2222")],
    optedOutPhones: async () => new Set(["96550001111", "96550002222"]),
  });
  const response = await handleWhatsAppBroadcast(request(), gate);
  assertEquals(await response.json(), { success: true, sent: 0, failed: 0, skipped: 2, status: "completed" });
  assertEquals(gate.graph, 0);
  assertEquals(gate.sending, 0);
});
