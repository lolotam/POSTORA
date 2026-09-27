import { assertEquals } from "jsr:@std/assert@1";
import { automationAllowedAfterInbound, isOptOutMessage, optOutDb, recordOptOut, type OptOutDb } from "./optOut.ts";

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
  ["stopped", false],
  ["unstoppable", false],
  ["", false],
] as const) {
  Deno.test(`isOptOutMessage ${JSON.stringify(text)} → ${expected}`, () => {
    assertEquals(isOptOutMessage(text), expected);
  });
}

for (const [optedOut, allowed] of [[true, false], [false, true]] as const) {
  Deno.test(`automationAllowedAfterInbound optedOut=${optedOut} → ${allowed}`, () => {
    assertEquals(automationAllowedAfterInbound({ optedOut }), allowed);
  });
}

const INPUT = {
  userId: "user", socialAccountId: "acc", phone: "96555512345", conversationId: "wa_1_96555512345",
};

function recordingDb(failAt?: "upsert" | "skip" | "clear") {
  const calls: Array<{ port: string; args: unknown[] }> = [];
  const db: OptOutDb = {
    async upsertOptOut(userId, phone) {
      if (failAt === "upsert") throw new Error("down");
      calls.push({ port: "upsertOptOut", args: [userId, phone] });
    },
    async skipEvents(socialAccountId, phone) {
      if (failAt === "skip") throw new Error("down");
      calls.push({ port: "skipEvents", args: [socialAccountId, phone] });
    },
    async clearEventProcedure(userId, conversationId) {
      if (failAt === "clear") throw new Error("down");
      calls.push({ port: "clearEventProcedure", args: [userId, conversationId] });
    },
    async warn(userId, socialAccountId) {
      calls.push({ port: "warn", args: [userId, socialAccountId] });
    },
  };
  return { db, calls };
}

Deno.test("recordOptOut upserts, then skips events, then clears the procedure, in that order", async () => {
  const fake = recordingDb();
  assertEquals(await recordOptOut(fake.db, INPUT), true);
  assertEquals(fake.calls, [
    { port: "upsertOptOut", args: ["user", "96555512345"] },
    { port: "skipEvents", args: ["acc", "96555512345"] },
    { port: "clearEventProcedure", args: ["user", "wa_1_96555512345"] },
  ]);
});

Deno.test("a failed opt-out write is logged and returns false", async () => {
  const fake = recordingDb("upsert");
  assertEquals(await recordOptOut(fake.db, INPUT), false);
  assertEquals(fake.calls, [{ port: "warn", args: ["user", "acc"] }]);
});

interface QueryCall { table: string; method: string; args: unknown[] }

function recordingAdmin(thread: { id: string; procedure_state: { origin?: string } } | null) {
  const calls: QueryCall[] = [];
  const from = (table: string) => {
    const api = {
      upsert(...args: unknown[]) { calls.push({ table, method: "upsert", args }); return api; },
      update(...args: unknown[]) { calls.push({ table, method: "update", args }); return api; },
      select(...args: unknown[]) { calls.push({ table, method: "select", args }); return api; },
      eq(...args: unknown[]) { calls.push({ table, method: "eq", args }); return api; },
      filter(...args: unknown[]) { calls.push({ table, method: "filter", args }); return api; },
      in(...args: unknown[]) { calls.push({ table, method: "in", args }); return api; },
      is(...args: unknown[]) { calls.push({ table, method: "is", args }); return api; },
      insert(...args: unknown[]) { calls.push({ table, method: "insert", args }); return api; },
      maybeSingle() {
        calls.push({ table, method: "maybeSingle", args: [] });
        return Promise.resolve({ data: table === "ai_threads" ? thread : null, error: null });
      },
      then(
        onFulfilled?: (value: { data: Array<{ id: string }> | null; error: null }) => unknown,
        onRejected?: (reason: unknown) => unknown,
      ) {
        return Promise.resolve({ data: thread ? [{ id: thread.id }] : [], error: null }).then(onFulfilled, onRejected);
      },
    };
    return api;
  };
  return { from, calls };
}

function callsOn(calls: QueryCall[], table: string, method: string): QueryCall[] {
  return calls.filter((call) => call.table === table && call.method === method);
}

Deno.test("optOutDb filters pending and claimed events for that account and phone, and clears an event flow", async () => {
  const state = { origin: "event" };
  const admin = recordingAdmin({ id: "thread-1", procedure_state: state });
  assertEquals(await recordOptOut(optOutDb(admin as never), INPUT), true);
  assertEquals(callsOn(admin.calls, "messaging_opt_outs", "upsert")[0].args, [
    { user_id: "user", phone: "96555512345", source: "whatsapp" },
    { onConflict: "user_id,phone" },
  ]);
  const events = admin.calls.filter((call) => call.table === "store_events");
  assertEquals(events.map((call) => call.method), ["update", "eq", "filter", "in"]);
  assertEquals(events[1].args, ["social_account_id", "acc"]);
  assertEquals(events[2].args, ["payload->>phone", "eq", "96555512345"]);
  assertEquals(events[3].args, ["status", ["pending", "claimed"]]);
  const cleared = callsOn(admin.calls, "ai_threads", "update");
  assertEquals(cleared.length, 1);
  assertEquals(cleared[0].args, [{ procedure_state: null }]);
  assertEquals(callsOn(admin.calls, "ai_threads", "eq").some((call) =>
    call.args[0] === "procedure_state" && call.args[1] === JSON.stringify(state)
  ), true);
});

Deno.test("optOutDb does not clear a Spec A procedure state", async () => {
  const admin = recordingAdmin({ id: "thread-1", procedure_state: { origin: "jev" } });
  assertEquals(await recordOptOut(optOutDb(admin as never), INPUT), true);
  assertEquals(callsOn(admin.calls, "ai_threads", "update"), []);
  assertEquals(admin.calls.filter((call) => call.table === "store_events").map((call) => call.method), ["update", "eq", "filter", "in"]);
});
