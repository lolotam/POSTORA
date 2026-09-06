import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ackUpdates,
  inboxStatusForAck,
  isMessageKeyId,
  normalizeAckStatus,
  shouldAdvanceStatus,
  statusesAdvancedBy,
} from "./evolutionMessageAck.ts";

Deno.test("ack status accepts Evolution strings and raw Baileys numbers", () => {
  assertEquals(normalizeAckStatus("DELIVERY_ACK"), "DELIVERY_ACK");
  assertEquals(normalizeAckStatus("read"), "READ");
  assertEquals(normalizeAckStatus(3), "DELIVERY_ACK");
  assertEquals(normalizeAckStatus(0), "ERROR");
  assertEquals(normalizeAckStatus("nope"), null);
});

Deno.test("ack maps onto inbox status", () => {
  assertEquals(inboxStatusForAck("DELIVERY_ACK"), "delivered");
  assertEquals(inboxStatusForAck("READ"), "read");
  assertEquals(inboxStatusForAck("PLAYED"), "read");
  assertEquals(inboxStatusForAck("ERROR"), "failed");
  assertEquals(inboxStatusForAck("SERVER_ACK"), null);
});

Deno.test("only own sends with a valid key become updates, in both payload shapes", () => {
  const updates = ackUpdates([
    { keyId: "3EB0AAAA1111", remoteJid: "9655@s.whatsapp.net", fromMe: true, status: "READ" },
    { key: { id: "3EB0BBBB2222", fromMe: true }, update: { status: 3 } },
    { keyId: "3EB0CCCC3333", fromMe: false, status: "READ" },
    { keyId: "bad id!", fromMe: true, status: "READ" },
    { keyId: "3EB0DDDD4444", fromMe: true, status: "SERVER_ACK" },
  ]);
  assertEquals(updates, [
    { messageId: "3EB0AAAA1111", status: "read" },
    { messageId: "3EB0BBBB2222", status: "delivered" },
  ]);
  assertEquals(isMessageKeyId("3EB0AAAA1111"), true);
});

Deno.test("the update predicate lists exactly the statuses an ack may overwrite", () => {
  assertEquals(statusesAdvancedBy("delivered"), ["sent"]);
  assertEquals(statusesAdvancedBy("read"), ["sent", "delivered"]);
  assertEquals(statusesAdvancedBy("failed"), ["sent", "delivered", "read"]);
});

Deno.test("status only moves forward and failed is terminal", () => {
  assertEquals(shouldAdvanceStatus("sent", "delivered"), true);
  assertEquals(shouldAdvanceStatus("read", "delivered"), false);
  assertEquals(shouldAdvanceStatus("delivered", "read"), true);
  assertEquals(shouldAdvanceStatus("failed", "read"), false);
  assertEquals(shouldAdvanceStatus(null, "delivered"), true);
});
