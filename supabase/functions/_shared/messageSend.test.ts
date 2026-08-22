import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { sendMessage } from "./messageSend.ts";

Deno.test("sendMessage normalizes WhatsApp conversation IDs and persists the outbound row", async () => {
  const rows: Array<{ table: string; value: unknown }> = [];
  const admin = stubAdmin(rows);
  const result = await sendMessage(admin, {
    account: {
      id: "account-1",
      user_id: "user-1",
      workspace_id: "workspace-1",
      platform: "whatsapp",
      platform_user_id: "phone-1",
      access_token: "token-1",
      platform_username: "Business",
      ig_auth_type: null,
      account_metadata: {},
    },
    recipientId: "+965 123 45678",
    message: "Hello",
    messageType: "text",
  }, async (_url, init) => {
    assertEquals(JSON.parse(String(init?.body)), {
      messaging_product: "whatsapp",
      to: "+965 123 45678",
      type: "text",
      text: { body: "Hello" },
    });
    return new Response(JSON.stringify({ messages: [{ id: "wamid.1" }] }), { status: 200 });
  });

  assertEquals(result.messageId, "wamid.1");
  assertEquals((rows.find((row) => row.table === "whatsapp_messages")?.value as any).conversation_id, "wa_phone-1_965 123 45678");
});

Deno.test("sendMessage sends a QR-linked WhatsApp account through the Evolution transport, not the Graph API", async () => {
  const rows: Array<{ table: string; value: unknown }> = [];
  const sent: unknown[] = [];
  const result = await sendMessage(stubAdmin(rows), {
    account: {
      id: "account-qr",
      user_id: "user-1",
      workspace_id: "workspace-1",
      platform: "whatsapp",
      platform_user_id: "96566980961",
      access_token: "",
      platform_username: null,
      ig_auth_type: null,
      account_metadata: {},
      connection_mode: "evolution_qr",
    },
    recipientId: "+965 5568 3677",
    message: "Hello",
    messageType: "text",
  }, async () => {
    throw new Error("Graph API must not be called for a QR account");
  }, async (_admin, account) => {
    assertEquals(account.connection_mode, "evolution_qr");
    return {
      async sendText(input) { sent.push(input); return { messageId: "evo.1", raw: { ok: true } }; },
      async sendMedia() { throw new Error("unexpected media send"); },
      async markRead() {},
    };
  });

  assertEquals(sent, [{ recipientPhone: "96555683677", text: "Hello" }]);
  assertEquals(result.messageId, "evo.1");
  const stored = rows.find((row) => row.table === "whatsapp_messages")?.value as any;
  assertEquals(stored.conversation_id, "wa_96566980961_96555683677");
  assertEquals(stored.direction, "outbound");
});

Deno.test("sendMessage replies through the existing Meta conversation endpoint", async () => {
  const rows: Array<{ table: string; value: unknown }> = [];
  let requestUrl = "";
  let requestBody: unknown;
  const result = await sendMessage(stubAdmin(rows), {
    account: {
      id: "account-2",
      user_id: "user-1",
      workspace_id: "workspace-1",
      platform: "instagram",
      platform_user_id: "ig-1",
      access_token: "ig-token",
      platform_username: "Business",
      ig_auth_type: "business_login",
      account_metadata: {},
    },
    recipientId: "sender-1",
    conversationId: "conversation-1",
    message: "Hello IG",
    messageType: "text",
  }, async (url, init) => {
    requestUrl = String(url);
    requestBody = JSON.parse(String(init?.body));
    return new Response(JSON.stringify({ message_id: "ig-message-1" }), { status: 200 });
  });

  assertEquals(result.messageId, "ig-message-1");
  assertEquals(requestUrl, "https://graph.instagram.com/v22.0/conversation-1/messages?access_token=ig-token");
  assertEquals(requestBody, { message: "Hello IG" });
});

function stubAdmin(rows: Array<{ table: string; value: unknown }>) {
  return {
    from(table: string) {
      return {
        insert(value: unknown) { rows.push({ table, value }); return Promise.resolve({ error: null }); },
        upsert(value: unknown) { rows.push({ table, value }); return Promise.resolve({ error: null }); },
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
      };
    },
  } as any;
}
