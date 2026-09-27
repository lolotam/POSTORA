import { assertEquals } from "jsr:@std/assert@1";
import { markRecipientsSkipped, partitionOptedOut } from "./optOut.ts";

const row = (id: string, phone_number: string) => ({ id, phone_number });

Deno.test("partitionOptedOut matches digits-only formatting and keeps order", () => {
  const recipients = [
    row("a", "+965 1234-5678"),
    row("b", "96500000000"),
    row("c", "+965 1234-5678"),
    row("d", "96599999999"),
  ];
  const result = partitionOptedOut(recipients, new Set(["96512345678"]));
  assertEquals(result.skipped.map((recipient) => recipient.id), ["a", "c"]);
  assertEquals(result.send.map((recipient) => recipient.id), ["b", "d"]);
});

Deno.test("partitionOptedOut sends everyone when the opt-out set is empty", () => {
  const recipients = [row("a", "+965 1234-5678"), row("b", "96500000000")];
  const result = partitionOptedOut(recipients, new Set());
  assertEquals(result.send, recipients);
  assertEquals(result.skipped, []);
});

Deno.test("partitionOptedOut skips every recipient in the set", () => {
  const recipients = [row("a", "96511111111"), row("b", "+965 2222-2222")];
  const result = partitionOptedOut(recipients, new Set(["96511111111", "96522222222"]));
  assertEquals(result.send, []);
  assertEquals(result.skipped.map((recipient) => recipient.id), ["a", "b"]);
});

Deno.test("markRecipientsSkipped scopes the update to this broadcast's pending ids", async () => {
  const calls: string[] = [];
  const admin = {
    from(table: string) {
      calls.push(table);
      return {
        update(values: { status: string; error_message: string }) {
          calls.push(`${values.status}:${values.error_message}`);
          return {
            eq(column: string, value: string) {
              calls.push(`${column}=${value}`);
              return {
                eq(column2: string, value2: string) {
                  calls.push(`${column2}=${value2}`);
                  return {
                    in(column3: string, values: string[]) {
                      calls.push(`${column3}=${values.join(",")}`);
                      return Promise.resolve({ error: null });
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
  };
  await markRecipientsSkipped(admin, "broadcast-1", ["r1", "r2"]);
  assertEquals(calls, [
    "whatsapp_broadcast_recipients",
    "skipped:opted_out",
    "broadcast_id=broadcast-1",
    "status=pending",
    "id=r1,r2",
  ]);
});

Deno.test("markRecipientsSkipped throws when the update fails", async () => {
  const admin = {
    from() {
      return {
        update() {
          return {
            eq() {
              return {
                eq() {
                  return { in: () => Promise.resolve({ error: { message: "check violation" } }) };
                },
              };
            },
          };
        },
      };
    },
  };
  let thrown = false;
  try {
    await markRecipientsSkipped(admin, "broadcast-1", ["r1"]);
  } catch {
    thrown = true;
  }
  assertEquals(thrown, true);
});
