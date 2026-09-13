import { assert, assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { deliverModelOutageFloor } from "./outage-floor.ts";
import type { EscalationTarget } from "./tools.ts";
import { activeOverrideMode } from "../_shared/conversationModeOverride.ts";

/** An admin stub whose every query resolves empty: no online agent, nobody notified. */
function quietAdmin(onTable?: (table: string) => void) {
  return {
    from(table: string) {
      onTable?.(table);
      // Every filter chains back to the same empty query, whatever the depth.
      const empty: Record<string, unknown> = {};
      empty.eq = () => empty;
      empty.is = () => empty;
      empty.abortSignal = () => empty;
      empty.maybeSingle = () => Promise.resolve({ data: null, error: null });
      empty.then = (resolve: (v: unknown) => void) => resolve({ data: [], error: null });
      return {
        upsert: () => Promise.resolve({ error: null }),
        select: () => empty,
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
    cachedConversation: { id: "cache-1", workspace_id: "workspace-1" },
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
  const tables: string[] = [];
  const admin = {
    from(table: string) {
      tables.push(table);
      if (table === "ai_conversation_modes") {
        const none: Record<string, unknown> = {};
        none.eq = () => none;
        none.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return { select: () => none, upsert: () => Promise.resolve({ error: null }) };
      }
      // Everything after the mute blows up.
      throw new Error("assignment table unavailable");
    },
  };
  const result = await deliverModelOutageFloor(
    DM, c.sender, "en", { ...target(), admin } as never, NONE,
  );

  // The mute must come first — that ordering is what makes a post-mute failure
  // survivable, so assert it rather than merely that something was queried.
  assertEquals(tables[0], "ai_conversation_modes");
  assertEquals(tables.includes("whatsapp_agents"), true);
  assertEquals(result.escalated, true);
  assertEquals(result.apology_sent, true);
  // Nobody was actually reached, so the copy must stay conservative.
  assertEquals(result.human_notified, false);
  assertEquals(c.sent[0].includes("notified"), false);
});

Deno.test("the outage floor mutes regardless of the account default", async () => {
  const c = collector();
  const captured: { storedRow: Record<string, unknown> | null } = { storedRow: null };
  const admin = {
    from(table: string) {
      if (table === "ai_conversation_modes") {
        const none: Record<string, unknown> = {};
        none.eq = () => none;
        none.maybeSingle = () => Promise.resolve({ data: null, error: null });
        return {
          // The pre-read finds no row, so the escalation writes.
          select: () => none,
          upsert: (payload: Record<string, unknown>) => {
            captured.storedRow = payload;
            return Promise.resolve({ error: null });
          },
        };
      }
      return {
        select: () => ({
          eq: () => ({
            is: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
            maybeSingle: () => Promise.resolve({ data: null }),
            abortSignal: () => ({ maybeSingle: () => Promise.resolve({ data: null }) }),
          }),
          abortSignal: () => ({
            then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
          }),
          then: (resolve: (v: unknown) => void) => resolve({ data: [] }),
        }),
        insert: () => Promise.resolve({ error: null }),
        update: () => ({ eq: () => Promise.resolve({ error: null }) }),
      };
    },
  };

  const t = target({
    admin,
    defaultMode: "human_then_ai",
    escalationTimeoutMinutes: 60,
  });

  const start = Date.now();
  const result = await deliverModelOutageFloor(DM, c.sender, "en", t, NONE);

  assertEquals(result.escalated, true);
  assertEquals(result.apology_sent, true);
  assertEquals(c.sent.length, 1);

  // The stored row is human_first with an expiry, proving muteRegardless: true reached escalateConversation
  // and overrode human_then_ai (which with offline agents would otherwise have stored human_then_ai).
  assert(captured.storedRow !== null);
  assertEquals(captured.storedRow.mode, "human_first");
  const expiresAtMs = Date.parse(captured.storedRow.expires_at as string);
  assertEquals(Number.isNaN(expiresAtMs), false);
  assertEquals(Math.abs(expiresAtMs - (start + 60 * 60_000)) < 5000, true);

  // An active override in human_first mutes the conversation so a second inbound during the window
  // is skipped by the reply gate and does not produce a second apology.
  assertEquals(activeOverrideMode(captured.storedRow as { mode: string; expires_at: string }, Date.now()), "human_first");
});
