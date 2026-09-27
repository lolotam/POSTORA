import { assertEquals } from "jsr:@std/assert@1";
import type { OptOutLookupAdmin } from "../_shared/optOutLookup.ts";
import { refuseOptedOutTemplate, sendOperatorWhatsAppMessage } from "./templateOptOut.ts";

const OPTED_OUT_TEXT = "This customer has opted out of WhatsApp messages. Templates cannot be sent to them.";
const FORMATTED_PHONE = "+965 5000-1111";
const STORED_PHONE = "96550001111";

function gracefulError(message: string, errorType: string): Response {
  return new Response(JSON.stringify({ error: message, error_type: errorType }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function optOutAdmin(rows: Array<{ user_id: string; phone: string }>, failLookup = false) {
  const logs: Array<Record<string, unknown>> = [];
  const queriedUserIds: string[] = [];
  const admin: OptOutLookupAdmin = {
    from(table: string) {
      if (table === "system_logs") {
        return {
          insert(row: Record<string, unknown>) {
            logs.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table !== "messaging_opt_outs") throw new Error(`unexpected table ${table}`);
      return {
        select() {
          return {
            in(_column: string, phones: string[]) {
              return {
                eq(_column: string, userId: string) {
                  queriedUserIds.push(userId);
                  if (failLookup) return Promise.resolve({ data: null, error: { message: "statement timeout" } });
                  const data = rows.filter((row) => row.user_id === userId && phones.includes(row.phone));
                  return Promise.resolve({ data, error: null });
                },
              };
            },
          };
        },
      };
    },
  };
  return { admin, logs, queriedUserIds };
}

function provider() {
  const calls: Array<string> = [];
  const send = (label: string) => () => {
    calls.push(label);
    return Promise.resolve({ messages: [{ id: "wamid.1" }] });
  };
  return { calls, send };
}

Deno.test("both operator template paths refuse an opted-out formatted phone and do not call the provider", async () => {
  const ownerId = "owner-1";
  for (const action of ["whatsapp_send_message", "whatsapp_send_template"] as const) {
    const { admin, logs } = optOutAdmin([{ user_id: ownerId, phone: STORED_PHONE }]);
    const sent = provider();
    const outcome = await refuseOptedOutTemplate(
      admin,
      { ownerId, recipientPhone: FORMATTED_PHONE, action },
      gracefulError,
      sent.send(action),
    );
    assertEquals(sent.calls, []);
    assertEquals(outcome instanceof Response, true);
    const body = await (outcome as Response).json();
    assertEquals(body, { error: OPTED_OUT_TEXT, error_type: "RECIPIENT_OPTED_OUT" });
    assertEquals(logs.length, 1);
    assertEquals(logs[0]?.user_id, ownerId);
    assertEquals(logs[0]?.source, "messaging-api");
    assertEquals(logs[0]?.metadata, { action, reason: "opted_out" });
    const serialized = JSON.stringify(logs);
    assertEquals(serialized.includes(STORED_PHONE), false);
    assertEquals(serialized.includes("5000"), false);
    assertEquals(serialized.includes(FORMATTED_PHONE), false);
  }
});

Deno.test("whatsapp_send_message template uses the same refusal as the dedicated template action", async () => {
  const { admin } = optOutAdmin([{ user_id: "owner-1", phone: STORED_PHONE }]);
  const sent = provider();
  const outcome = await sendOperatorWhatsAppMessage(
    admin,
    { ownerId: "owner-1", recipientPhone: FORMATTED_PHONE, messageType: "template" },
    gracefulError,
    sent.send("template-message"),
  );
  assertEquals(sent.calls, []);
  assertEquals(outcome instanceof Response, true);
  assertEquals((await (outcome as Response).json()).error_type, "RECIPIENT_OPTED_OUT");
});

Deno.test("free-form text to an opted-out number still sends and writes no refusal log", async () => {
  const { admin, logs, queriedUserIds } = optOutAdmin([{ user_id: "owner-1", phone: STORED_PHONE }]);
  for (const messageType of [undefined, "text"] as const) {
    const sent = provider();
    const outcome = await sendOperatorWhatsAppMessage(
      admin,
      { ownerId: "owner-1", recipientPhone: FORMATTED_PHONE, messageType },
      gracefulError,
      sent.send("text"),
    );
    assertEquals(sent.calls, ["text"]);
    assertEquals(outcome, { messages: [{ id: "wamid.1" }] });
  }
  assertEquals(logs, []);
  assertEquals(queriedUserIds, []);
});

Deno.test("a workspace member's template is checked against the account owner's opt-outs", async () => {
  const ownerId = "owner-1";
  const memberId = "member-9";
  const { admin, logs, queriedUserIds } = optOutAdmin([{ user_id: ownerId, phone: STORED_PHONE }]);
  const sent = provider();
  const outcome = await refuseOptedOutTemplate(
    admin,
    { ownerId, recipientPhone: STORED_PHONE, action: "whatsapp_send_template" },
    gracefulError,
    sent.send("member"),
  );
  assertEquals(sent.calls, []);
  assertEquals(queriedUserIds, [ownerId]);
  assertEquals(queriedUserIds.includes(memberId), false);
  assertEquals(logs[0]?.user_id, ownerId);
  assertEquals((await (outcome as Response).json()).error_type, "RECIPIENT_OPTED_OUT");
});

Deno.test("another owner's identical phone is still allowed to receive a template", async () => {
  const { admin, logs, queriedUserIds } = optOutAdmin([{ user_id: "owner-a", phone: STORED_PHONE }]);
  const sent = provider();
  const outcome = await refuseOptedOutTemplate(
    admin,
    { ownerId: "owner-b", recipientPhone: FORMATTED_PHONE, action: "whatsapp_send_template" },
    gracefulError,
    sent.send("other-owner"),
  );
  assertEquals(queriedUserIds, ["owner-b"]);
  assertEquals(sent.calls, ["other-owner"]);
  assertEquals(outcome, { messages: [{ id: "wamid.1" }] });
  assertEquals(logs, []);
});

Deno.test("an @lid or a non-phone recipient is refused before the opt-out lookup", async () => {
  const cases = ["166095025660123@lid", "12345", "1234567890123456", "user@example.com"];
  for (const recipientPhone of cases) {
    const { admin, logs, queriedUserIds } = optOutAdmin([{ user_id: "owner-1", phone: STORED_PHONE }]);
    const sent = provider();
    const outcome = await refuseOptedOutTemplate(
      admin,
      { ownerId: "owner-1", recipientPhone, action: "whatsapp_send_template" },
      gracefulError,
      sent.send("invalid"),
    );
    assertEquals(sent.calls, []);
    assertEquals(queriedUserIds, []);
    assertEquals(logs.map((log) => log.metadata), [{ action: "whatsapp_send_template", reason: "invalid_recipient" }]);
    assertEquals(JSON.stringify(logs).includes(recipientPhone), false);
    const body = await (outcome as Response).json();
    assertEquals(body.error_type, "INVALID_RECIPIENT");
    assertEquals(JSON.stringify(body).includes(recipientPhone), false);
  }
});

Deno.test("an opt-out lookup failure sends nothing and logs the refusal without the phone", async () => {
  const { admin, logs } = optOutAdmin([{ user_id: "owner-1", phone: STORED_PHONE }], true);
  const sent = provider();
  const outcome = await refuseOptedOutTemplate(
    admin,
    { ownerId: "owner-1", recipientPhone: FORMATTED_PHONE, action: "whatsapp_send_message" },
    gracefulError,
    sent.send("lookup-failed"),
  );
  assertEquals(sent.calls, []);
  const body = await (outcome as Response).json();
  assertEquals(body.error_type, "OPT_OUT_LOOKUP_FAILED");
  assertEquals(logs.length, 1);
  assertEquals(logs[0]?.metadata, { action: "whatsapp_send_message", reason: "opt_out_lookup_failed" });
  assertEquals(JSON.stringify(logs).includes(STORED_PHONE), false);
  assertEquals(JSON.stringify(body).includes(STORED_PHONE), false);
});

Deno.test("a rejected opt-out request is a lookup failure, not a 500", async () => {
  const { admin: base, logs } = optOutAdmin([]);
  const admin: OptOutLookupAdmin = {
    from(table: string) {
      if (table === "messaging_opt_outs") throw new TypeError("network connection lost");
      return base.from(table);
    },
  };
  const sent = provider();
  const outcome = await refuseOptedOutTemplate(
    admin,
    { ownerId: "owner-1", recipientPhone: FORMATTED_PHONE, action: "whatsapp_send_template" },
    gracefulError,
    sent.send("rejected"),
  );
  assertEquals(sent.calls, []);
  assertEquals((await (outcome as Response).json()).error_type, "OPT_OUT_LOOKUP_FAILED");
  assertEquals(logs.map((log) => log.metadata), [{ action: "whatsapp_send_template", reason: "opt_out_lookup_failed" }]);
});
