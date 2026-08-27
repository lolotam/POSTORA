import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deliverModelOutageFloor } from "./outage-floor.ts";
import type { EscalationTarget } from "./tools.ts";

/** An admin stub whose every query resolves empty: no online agent, nobody notified. */
function quietAdmin(onTable?: (table: string) => void) {
  return {
    from(table: string) {
      onTable?.(table);
      return {
        upsert: () => Promise.resolve({ error: null }),
        select: () => ({
          eq: () => ({ is: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }) }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  };
}

function target(overrides: Partial<EscalationTarget> = {}): EscalationTarget {
  return {
    admin: quietAdmin(),
    userId: "00000000-0000-0000-0000-000000000001",
    platform: "instagram",
    conversationId: "conversation-1",
    customerName: "Test customer",
    adminPhoneNumbers: [],
    sendWhatsAppText: () => Promise.resolve(),
    ...overrides,
  } as EscalationTarget;
}

function collector() {
  const sent: string[] = [];
  return { sent, sender: (_to: string, text: string) => { sent.push(text); return Promise.resolve("id"); } };
}

const DM = { recipient_phone: "96500000000" };
const NONE = { escalated: false, humanNotified: false };

Deno.test("a failed escalation sends nothing at all", async () => {
  const c = collector();
  const broken = target({ admin: { from() { throw new Error("db down"); } } as never });
  // An unmuted conversation would apologise again on every later message, forever.
  const result = await deliverModelOutageFloor(DM, c.sender, "en", broken, NONE);
  assertEquals(result, { apology_sent: false, escalated: false, human_notified: false });
  assertEquals(c.sent.length, 0);
});

Deno.test("a comment escalates but posts nothing publicly", async () => {
  const c = collector();
  const result = await deliverModelOutageFloor(
    { ...DM, comment_id: "comment-1" }, c.sender, "en", target(), NONE,
  );
  assertEquals(c.sent.length, 0);
  assertEquals(result.escalated, true);
});

Deno.test("a prior tool escalation is not repeated", async () => {
  const c = collector();
  const tables: string[] = [];
  const t = target({ admin: quietAdmin((table) => tables.push(table)) as never });
  const result = await deliverModelOutageFloor(
    DM, c.sender, "en", t, { escalated: true, humanNotified: true },
  );
  assertEquals(tables.length, 0);
  assertEquals(result.escalated, true);
  assertEquals(c.sent.length, 1);
});

Deno.test("the copy does not claim a notification that did not happen", async () => {
  const c = collector();
  const result = await deliverModelOutageFloor(DM, c.sender, "en", target(), NONE);
  assertEquals(result.human_notified, false);
  assertEquals(c.sent[0].includes("notified"), false);
});

// escalate_to_human reports escalated: true on a bare mute, so a prior escalation
// that reached nobody must still use the conservative wording.
Deno.test("a prior escalation that reached nobody keeps the queued wording", async () => {
  const c = collector();
  const result = await deliverModelOutageFloor(
    DM, c.sender, "en", target(), { escalated: true, humanNotified: false },
  );
  assertEquals(result.human_notified, false);
  assertEquals(c.sent[0].includes("notified"), false);
});

Deno.test("a null sender still escalates", async () => {
  // buildReplySender returns null on a dry run, and the caller skips the floor then --
  // but the floor must not depend on that guard holding.
  const result = await deliverModelOutageFloor(DM, null, "en", target(), NONE);
  assertEquals(result.apology_sent, false);
  assertEquals(result.escalated, true);
});

Deno.test("a failing sender leaves the escalation in place", async () => {
  const failing = () => Promise.reject(new Error("Graph API 500"));
  const result = await deliverModelOutageFloor(DM, failing, "en", target(), NONE);
  assertEquals(result.apology_sent, false);
  assertEquals(result.escalated, true);
});

Deno.test("the Arabic apology is used for an Arabic conversation", async () => {
  const c = collector();
  await deliverModelOutageFloor(DM, c.sender, "ar", target(), NONE);
  assertEquals(/[؀-ۿ]/.test(c.sent[0]), true);
});

// CodeRabbit, PR #37: once the mode upsert lands the conversation is muted, so a
// later assignment failure must NOT read as "escalation failed" -- that would
// suppress the apology and leave the customer in permanent silence, which is
// worse than either failure alone.
Deno.test("a post-mute assignment failure still counts as escalated", async () => {
  const c = collector();
  let call = 0;
  const admin = {
    from(table: string) {
      call++;
      if (table === "ai_conversation_modes") {
        return { upsert: () => Promise.resolve({ error: null }) };
      }
      // Everything after the mute blows up.
      throw new Error("assignment table unavailable");
    },
  };
  const result = await deliverModelOutageFloor(
    DM, c.sender, "en", { ...target(), admin } as never, NONE,
  );

  assertEquals(result.escalated, true);
  assertEquals(result.apology_sent, true);
  // Nobody was actually reached, so the copy must stay conservative.
  assertEquals(result.human_notified, false);
  assertEquals(c.sent[0].includes("notified"), false);
  assertEquals(call > 0, true);
});
