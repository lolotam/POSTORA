import { assertEquals } from "jsr:@std/assert@1";
import { handleScheduledSender, type DueScheduledMessage, type ScheduledSenderDeps } from "./handler.ts";

const PHONE = "+965 5000-1111";
const DIGITS = "96550001111";

function message(id: string, userId: string): DueScheduledMessage {
  return {
    id,
    user_id: userId,
    social_account_id: `acc-${userId}`,
    recipient_phone: PHONE,
    message_text: "hello",
    media_url: null,
    media_type: null,
    social_accounts: { platform_user_id: "pnid", access_token: "account-token" },
  };
}

function deps(messages: DueScheduledMessage[], extra: Partial<ScheduledSenderDeps> = {}) {
  const gate = {
    graph: [] as string[],
    updates: [] as Array<{ id: string; patch: Record<string, unknown> }>,
    lookups: [] as Array<{ userId: string; phones: string[] }>,
    logs: [] as Array<{ userId: string; reason: string; metadata: Record<string, unknown> }>,
    authorize: () => ({ ok: true as const }),
    loadDue: async () => ({ messages }),
    optedOutPhones: async (userId: string, phones: string[]) => {
      gate.lookups.push({ userId, phones });
      return userId === "user-a" ? new Set([DIGITS]) : new Set<string>();
    },
    logSendRefused: async (input: { userId: string; reason: string; metadata: Record<string, unknown> }) => {
      gate.logs.push({ userId: input.userId, reason: input.reason, metadata: input.metadata });
    },
    updateMessage: async (id: string, patch: Record<string, unknown>) => { gate.updates.push({ id, patch }); },
    insertOutbound: async () => {},
    postGraph: async (_url: string, _token: string, payload: Record<string, unknown>) => {
      gate.graph.push(String(payload.to));
      return { data: { messages: [{ id: "wamid" }] } };
    },
    envToken: () => undefined,
    now: () => new Date("2026-09-27T12:00:00Z"),
  };
  return Object.assign(gate, extra);
}

const request = () => new Request("https://api.example/whatsapp-scheduled-sender", { method: "POST" });

Deno.test("an opted-out scheduled message is skipped while another user's same phone is sent", async () => {
  const gate = deps([message("msg-a", "user-a"), message("msg-b", "user-b")]);
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), { processed: 1, total: 2 });
  assertEquals(gate.lookups.map((lookup) => lookup.userId).sort(), ["user-a", "user-b"]);
  assertEquals(gate.lookups.every((lookup) => lookup.phones.length === 1), true);
  assertEquals(gate.graph, [PHONE]);
  assertEquals(gate.updates.map((update) => [update.id, update.patch.status]), [
    ["msg-a", "skipped"],
    ["msg-b", "sent"],
  ]);
  assertEquals(gate.updates[0]?.patch.error_message, "opted_out");
  assertEquals(gate.logs[0], { userId: "user-a", reason: "opted_out", metadata: { scheduled_message_id: "msg-a" } });
  assertEquals(JSON.stringify(gate.logs).includes(DIGITS), false);
});

Deno.test("a scheduled opt-out lookup failure leaves that user's messages pending and sends none", async () => {
  const gate = deps([message("msg-a", "user-a"), message("msg-a2", "user-a")], {
    optedOutPhones: async () => { throw new Error("opt_out_lookup_failed"); },
  });
  const response = await handleScheduledSender(request(), gate);
  assertEquals(await response.json(), { processed: 0, total: 2 });
  assertEquals(gate.graph, []);
  assertEquals(gate.updates, []);
  assertEquals(gate.logs[0]?.reason, "opt_out_lookup_failed");
  assertEquals(JSON.stringify(gate.logs).includes(DIGITS), false);
});

Deno.test("a failed opted-out status write is logged and the message is not sent", async () => {
  const gate = deps([message("msg-a", "user-a")], {
    updateMessage: async () => { throw new Error("scheduled_message_update_failed"); },
  });
  await handleScheduledSender(request(), gate);
  assertEquals(gate.graph, []);
  assertEquals(gate.logs, [{ userId: "user-a", reason: "opt_out_skip_failed", metadata: { scheduled_message_id: "msg-a" } }]);
});
