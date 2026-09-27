import { assertEquals } from "jsr:@std/assert@1";
import { isOptOutMessage, recordOptOut, type OptOutDb } from "./optOut.ts";

for (const [text, expected] of [
  ["stop", true],
  ["  UNSUBSCRIBE ", true],
  ["stop messaging", true],
  ["don't message me", true],
  ["dont message me", true],
  ["توقف", true],
  ["إلغاء الاشتراك", true],
  ["الغاء الاشتراك", true],
  ["لا ترسل", true],
  ["please stop sending", false],
  ["stop please", false],
  ["", false],
] as const) {
  Deno.test(`isOptOutMessage ${JSON.stringify(text)} → ${expected}`, () => {
    assertEquals(isOptOutMessage(text), expected);
  });
}

function fakeDb(failAt?: "upsert" | "skip" | "clear") {
  const events = [
    { socialAccountId: "acc", phone: "96555512345", status: "pending", skip_reason: "" },
    { socialAccountId: "acc", phone: "96555512345", status: "sent", skip_reason: "" },
    { socialAccountId: "other", phone: "96555512345", status: "claimed", skip_reason: "" },
  ];
  let state: { origin: string } | null = { origin: "event" };
  const optOuts: string[] = [];
  const warnings: string[] = [];
  const db: OptOutDb = {
    async upsertOptOut(_userId, phone) {
      if (failAt === "upsert") throw new Error("down");
      optOuts.push(phone);
    },
    async skipEvents(socialAccountId, phone) {
      if (failAt === "skip") throw new Error("down");
      for (const event of events) {
        if (event.socialAccountId === socialAccountId && event.phone === phone && (event.status === "pending" || event.status === "claimed")) {
          event.status = "skipped";
          event.skip_reason = "opted_out";
        }
      }
    },
    async clearEventProcedure() {
      if (failAt === "clear") throw new Error("down");
      if (state?.origin === "event") state = null;
    },
    async warn(userId, socialAccountId) {
      warnings.push(`${userId}:${socialAccountId}`);
    },
  };
  return { db, events, optOuts, warnings, readState: () => state };
}

Deno.test("recordOptOut upserts, skips pending events for that account and phone, and clears an event flow", async () => {
  const fake = fakeDb();
  assertEquals(await recordOptOut(fake.db, {
    userId: "user", socialAccountId: "acc", phone: "96555512345", conversationId: "wa_1_96555512345",
  }), true);
  assertEquals(fake.optOuts, ["96555512345"]);
  assertEquals(fake.events.map((event) => event.status), ["skipped", "sent", "claimed"]);
  assertEquals(fake.events[0].skip_reason, "opted_out");
  assertEquals(fake.readState(), null);
  assertEquals(fake.warnings, []);
});

Deno.test("a failed opt-out write is logged and returns false", async () => {
  const fake = fakeDb("upsert");
  assertEquals(await recordOptOut(fake.db, {
    userId: "user", socialAccountId: "acc", phone: "96555512345", conversationId: "c",
  }), false);
  assertEquals(fake.warnings, ["user:acc"]);
  assertEquals(fake.events[0].status, "pending");
});
