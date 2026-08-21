import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEvolutionMessageRow, describeMessageContent, isPersistableMessage } from "./evolutionMessage.ts";

const ACCOUNT = { id: "acc-1", user_id: "user-1", platform_user_id: "96597950350" };

function baileysMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: { id: "3EB088496DD5BCE31F6874", fromMe: false, remoteJid: "96555683677@s.whatsapp.net" },
    pushName: "Abu Tork",
    messageType: "conversation",
    message: { conversation: "hello" },
    messageTimestamp: 1787268633,
    ...overrides,
  };
}

Deno.test("a message from the contact is stored with the contact as sender", () => {
  const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage())!;
  assertEquals(built.conversationId, "wa_96597950350_96555683677");
  assertEquals(built.sentByOwner, false);
  assertEquals(built.participantName, "Abu Tork");
  assertEquals(built.row.from_phone, "96555683677");
  assertEquals(built.row.to_phone, "96597950350");
  assertEquals(built.row.direction, "inbound");
  assertEquals(built.row.status, "received");
});

Deno.test("a message the owner sent from their phone renders as one of ours", () => {
  // 2026-08-21 incident: the inbox decides the bubble side with `msg.from.id === pageId`
  // where pageId is the account's platform_user_id, and never reads `direction`. Storing
  // the contact as sender therefore drew the operator's own messages as if received.
  const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage({
    key: { id: "OWNED1", fromMe: true, remoteJid: "96555683677@s.whatsapp.net" },
    pushName: "Você",
  }))!;
  assertEquals(built.sentByOwner, true);
  assertEquals(built.row.from_phone, "96597950350");
  assertEquals(built.row.to_phone, "96555683677");
  assertEquals(built.row.from_name, "You");
  assertEquals(built.row.direction, "outbound");
  assertEquals(built.row.status, "sent");
  // Blank so the contact's resolved name is not overwritten by the operator's own.
  assertEquals(built.participantName, "");
});

Deno.test("both directions of one chat share a single conversation id", () => {
  // A mismatch here splits one conversation into two rows in the inbox.
  const inbound = buildEvolutionMessageRow(ACCOUNT, baileysMessage())!;
  const outbound = buildEvolutionMessageRow(ACCOUNT, baileysMessage({
    key: { id: "OWNED1", fromMe: true, remoteJid: "96555683677@s.whatsapp.net" },
  }))!;
  assertEquals(inbound.conversationId, outbound.conversationId);
});

Deno.test("a delivery status on a real message no longer discards it", () => {
  // 2026-08-21 incident: the old guard was `!message.status`, but Evolution stamps a
  // delivery status onto genuine messages, so it dropped real traffic.
  const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage({ status: "DELIVERY_ACK" }));
  assertEquals(built?.row.message_text, "hello");
});

Deno.test("only addressable one-to-one chats are persisted", async (t) => {
  // Group and privacy JIDs have no phone number, so their digits would collide inside the
  // wa_<owner>_<number> id and could not be replied to. They are skipped to match the
  // history sync's scope rather than stored as unusable conversations.
  const cases: Array<[string, Record<string, unknown>, boolean]> = [
    ["direct chat", {}, true],
    ["group chat", { key: { id: "m", fromMe: false, remoteJid: "120363301653814403@g.us" } }, false],
    ["privacy id", { key: { id: "m", fromMe: false, remoteJid: "166095025660123@lid" } }, false],
    ["status broadcast", { key: { id: "m", fromMe: false, remoteJid: "status@broadcast" } }, false],
    ["protocol message", { messageType: "protocolMessage" }, false],
    ["no message body", { message: undefined }, false],
  ];

  for (const [label, overrides, expected] of cases) {
    await t.step(label, () => {
      assertEquals(isPersistableMessage(baileysMessage(overrides)), expected);
    });
  }
});

Deno.test("each media kind gets a preview the inbox can render", async (t) => {
  const cases: Array<[string, Record<string, unknown>, string, string]> = [
    ["plain text", { conversation: "hi" }, "hi", "text"],
    ["quoted text", { extendedTextMessage: { text: "quoted" } }, "quoted", "text"],
    ["captioned image", { imageMessage: { caption: "a cat" } }, "a cat", "image"],
    ["uncaptioned image", { imageMessage: {} }, "[Image]", "image"],
    ["document", { documentMessage: { fileName: "bill.pdf" } }, "[Document] bill.pdf", "document"],
    ["audio", { audioMessage: {} }, "[Audio message]", "audio"],
    ["sticker", { stickerMessage: {} }, "[Sticker]", "sticker"],
  ];

  for (const [label, body, text, type] of cases) {
    await t.step(label, () => {
      const content = describeMessageContent({ message: body });
      assertEquals(content.text, text);
      assertEquals(content.type, type);
    });
  }
});

Deno.test("a chat with no push name falls back to the contact number", () => {
  const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage({ pushName: undefined }))!;
  assertEquals(built.participantName, "96555683677");
});
