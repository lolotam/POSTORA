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
