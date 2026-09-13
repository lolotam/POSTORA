// deno-lint-ignore-file no-import-prefix
// supabase/functions/_shared/conversationModeOverride.test.ts
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  activeOverrideMode,
  escalationOverride,
  isOverrideExpired,
  resolveConversationOverride,
} from "./conversationModeOverride.ts";

const NOW = Date.parse("2026-09-13T10:00:00Z");

Deno.test("an override with no expiry applies until released", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: null }, NOW), "human_first");
  assertEquals(activeOverrideMode({ mode: "human_first" }, NOW), "human_first");
});

Deno.test("an override past its expiry is treated as absent", () => {
  const row = { mode: "human_first", expires_at: "2026-09-13T09:59:59Z" };
  assertEquals(isOverrideExpired(row, NOW), true);
  assertEquals(activeOverrideMode(row, NOW), null);
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "2026-09-13T10:00:01Z" }, NOW), "human_first");
});

Deno.test("an unparseable expiry never silences a conversation for ever", () => {
  assertEquals(activeOverrideMode({ mode: "human_first", expires_at: "garbage" }, NOW), null);
});

Deno.test("escalation gives humans an exclusive window only when one was assigned", () => {
  assertEquals(escalationOverride("human_then_ai", true, 30, NOW), { mode: "human_first", expires_at: "2026-09-13T10:30:00.000Z" });
  assertEquals(escalationOverride("human_then_ai", false, 30, NOW).mode, "human_then_ai");
  assertEquals(escalationOverride("ai_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride("human_first", false, 30, NOW).mode, "human_first");
  assertEquals(escalationOverride(undefined, false, 30, NOW).mode, "human_first");
});

Deno.test("escalation timeout defaults to 240 minutes and is clamped to the allowed range", () => {
  assertEquals(escalationOverride("ai_first", false, null, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 0, NOW).expires_at, "2026-09-13T14:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, 999999, NOW).expires_at, "2026-09-20T10:00:00.000Z");
  assertEquals(escalationOverride("ai_first", false, -5, NOW).expires_at, "2026-09-13T10:01:00.000Z");
});

// A fake PostgREST client for the reader: one stored row (or none), a delete
// that honours its own filters, and a hook that lets a test change the row
// between the reader's first read and its delete -- the operator race.
type StoredRow = Record<string, unknown> | null;
function readerClient(
  initial: StoredRow,
  options: { afterFirstRead?: () => StoredRow; failDelete?: boolean } = {},
) {
  const calls: string[] = [];
  let current = initial;
  let reads = 0;
  const matches = (filters: [string, unknown][]) =>
    current !== null && filters.every(([key, value]) => current![key] === value);
  const admin = {
    from(_table: string) {
      const filters: [string, unknown][] = [];
      let op = "select";
      const query = {
        select: () => query,
        delete: () => { op = "delete"; return query; },
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        maybeSingle: () => {
          calls.push("read");
          const data = matches(filters) ? current : null;
          reads++;
          if (reads === 1 && options.afterFirstRead) current = options.afterFirstRead();
          return Promise.resolve({ data, error: null });
        },
        then: (resolve: (value: unknown) => unknown) => {
          calls.push(op);
          if (options.failDelete) return Promise.resolve({ data: null, error: { message: "timeout" } }).then(resolve);
          const hit = matches(filters);
          const deleted = hit ? [{ id: current!.id }] : [];
          if (hit) current = null;
          return Promise.resolve({ data: deleted, error: null }).then(resolve);
        },
      };
      return query;
    },
  };
  return { admin, calls, stored: () => current };
}

const SCOPE = { userId: "u1", platform: "whatsapp", conversationId: "c1" };
const ROW = { id: "m1", user_id: "u1", platform: "whatsapp", conversation_id: "c1" };

Deno.test("reader: an active override is returned and nothing is deleted", async () => {
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T11:00:00Z" });
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), "human_first");
  assertEquals(c.calls, ["read"]);
});

Deno.test("reader: an expired override reads as absent and the exact row is deleted", async () => {
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" });
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), null);
  assertEquals(c.calls, ["read", "delete"]);
  assertEquals(c.stored(), null);
});

Deno.test("reader: a manual row written after the read is not deleted and wins", async () => {
  // Between the read and the delete an operator sets a manual human_first
  // (expires_at null). The delete filters on the observed expires_at, so it
  // removes nothing; the re-read then honours the operator's row.
  const c = readerClient(
    { ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" },
    { afterFirstRead: () => ({ ...ROW, mode: "human_first", expires_at: null }) },
  );
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), "human_first");
  assertEquals(c.calls, ["read", "delete", "read"]);
  assertEquals(c.stored()?.expires_at, null);
});

Deno.test("reader: a failed delete is logged, not fatal, and the expired row is ignored", async () => {
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" }, { failDelete: true });
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), null);
  } finally {
    console.error = originalError;
  }
  assertEquals(logged.length, 1);
});
