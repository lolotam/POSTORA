import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { buildEvolutionMessageRow, remoteNumberFor } from "./evolutionMessage.ts";

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
    ["LID with no number anywhere", { key: { id: "m", fromMe: false, remoteJid: "166095025660123@lid" } }, false],
    ["LID carrying its number", {
      key: { id: "m", fromMe: false, remoteJid: "166095025660123@lid", remoteJidAlt: "96555683677@s.whatsapp.net" },
    }, true],
    ["status broadcast", { key: { id: "m", fromMe: false, remoteJid: "status@broadcast" } }, false],
    ["newsletter", { key: { id: "m", fromMe: false, remoteJid: "120363144038483540@newsletter" } }, false],
    ["protocol message", { messageType: "protocolMessage" }, false],
    ["no message body", { message: undefined }, false],
  ];

  for (const [label, overrides, expected] of cases) {
    await t.step(label, () => {
      assertEquals(buildEvolutionMessageRow(ACCOUNT, baileysMessage(overrides)) !== null, expected);
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
      const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage({ message: body }))!;
      assertEquals(built.row.message_text, text);
      assertEquals(built.row.message_type, type);
    });
  }
});

Deno.test("a chat with no push name falls back to the contact number", () => {
  const built = buildEvolutionMessageRow(ACCOUNT, baileysMessage({ pushName: undefined }))!;
  assertEquals(built.participantName, "96555683677");
});

// Codex review on PR #14: Evolution can supply a multi-device JID carrying a
// ":<device>" component. Stripping every non-digit spliced the device number onto
// the subscriber number, fabricating a different phone number that reached both the
// conversation id and the dispatched sender payload -- so automations, and the n8n
// Message node whose recipient defaults to sender.id, could reply to the wrong number.
Deno.test("a multi-device JID resolves to the subscriber number, not the device", () => {
  assertEquals(remoteNumberFor("96597950350:12@s.whatsapp.net"), "96597950350");
});

Deno.test("remoteNumberFor leaves JIDs without a device component untouched", async (t) => {
  const unchanged: Array<[string, string]> = [
    ["96597950350@s.whatsapp.net", "96597950350"],
    ["8801647336747@s.whatsapp.net", "8801647336747"],
    ["96597950350", "96597950350"],
  ];
  for (const [jid, expected] of unchanged) {
    await t.step(jid, () => assertEquals(remoteNumberFor(jid), expected));
  }
});

Deno.test("a JID with no digits at all falls back to the raw value", () => {
  assertEquals(remoteNumberFor("status@broadcast"), "status@broadcast");
});

Deno.test("a device-suffixed chat shares the conversation id of its plain form", () => {
  const plain = buildEvolutionMessageRow(ACCOUNT, baileysMessage())!;
  const multiDevice = buildEvolutionMessageRow(
    ACCOUNT,
    baileysMessage({
      key: { id: "OTHER", fromMe: false, remoteJid: "96555683677:41@s.whatsapp.net" },
    }),
  )!;
  assertEquals(multiDevice.conversationId, plain.conversationId);
});

Deno.test("one LID message lands in the same conversation whichever path delivers it", () => {
  // 2026-08-28: Evolution normalises the live webhook payload to the phone JID but stores
  // the historical record under the LID, so reading only `remoteJid` split one contact's
  // messages across wa_<owner>_<phone> and wa_<owner>_<lid>.
  const live = buildEvolutionMessageRow(ACCOUNT, baileysMessage({
    key: { id: "AC3A", fromMe: false, remoteJid: "96569983891@s.whatsapp.net", remoteJidAlt: "96569983891@s.whatsapp.net" },
  }))!;
  const stored = buildEvolutionMessageRow(ACCOUNT, baileysMessage({
    key: { id: "AC3A", fromMe: false, remoteJid: "40557493641315@lid", remoteJidAlt: "96569983891@s.whatsapp.net" },
  }))!;

  assertEquals(stored.conversationId, live.conversationId);
  assertEquals(stored.row, live.row);
});

Deno.test("a caller-supplied chat address covers keys that omit the number", () => {
  // Evolution repeats the LID-to-number alternate on only a few keys per chat, so the sweep
  // resolves the chat once and carries that address across its remaining messages.
  const built = buildEvolutionMessageRow(
    ACCOUNT,
    baileysMessage({ key: { id: "OLD", fromMe: false, remoteJid: "40557493641315@lid" } }),
    "96569983891@s.whatsapp.net",
  )!;

  assertEquals(built.conversationId, "wa_96597950350_96569983891");
  assertEquals(built.row.from_phone, "96569983891");
});

Deno.test("a key that names its own number ignores the caller's fallback", () => {
  // The fallback is a last resort, never an override: a group message swept inside a chat
  // must not be relabelled as that chat's contact.
  const built = buildEvolutionMessageRow(
    ACCOUNT,
    baileysMessage({ key: { id: "M", fromMe: false, remoteJid: "96555683677@s.whatsapp.net" } }),
    "96569983891@s.whatsapp.net",
  )!;

  assertEquals(built.conversationId, "wa_96597950350_96555683677");
});
