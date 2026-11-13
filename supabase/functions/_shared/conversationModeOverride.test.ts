// deno-lint-ignore-file no-import-prefix
// supabase/functions/_shared/conversationModeOverride.test.ts
import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
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

// A fake PostgREST client for the reader: one stored row (or none), the
// expire_conversation_mode RPC honouring its own arguments, and a hook that
// lets a test change the row between the reader's first read and the expiry
// -- the operator race.
type StoredRow = Record<string, unknown> | null;
function readerClient(
  initial: StoredRow,
  options: { afterFirstRead?: () => StoredRow; failExpire?: boolean } = {},
) {
  const calls: string[] = [];
  let current = initial;
  let reads = 0;
  const matches = (filters: [string, unknown][]) =>
    current !== null && filters.every(([key, value]) => current![key] === value);
  const admin = {
    from(_table: string) {
      const filters: [string, unknown][] = [];
      const query = {
        select: () => query,
        eq: (key: string, value: unknown) => { filters.push([key, value]); return query; },
        maybeSingle: () => {
          calls.push("read");
          const data = matches(filters) ? current : null;
          reads++;
          if (reads === 1 && options.afterFirstRead) current = options.afterFirstRead();
          return Promise.resolve({ data, error: null });
        },
      };
      return query;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push(name);
      if (options.failExpire) return Promise.resolve({ data: null, error: { message: "timeout" } });
      const hit = matches([["id", args.p_mode_id], ["user_id", args.p_user_id], ["expires_at", args.p_expires_at]]);
      if (hit) current = null;
      return Promise.resolve({ data: hit, error: null });
    },
  };
  return { admin, calls, stored: () => current };
}

const SCOPE = { userId: "u1", platform: "whatsapp", conversationId: "c1" };
const ROW = { id: "m1", user_id: "u1", platform: "whatsapp", conversation_id: "c1" };

Deno.test("reader: an active override is returned and nothing is expired", async () => {
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T11:00:00Z" });
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), "human_first");
  assertEquals(c.calls, ["read"]);
});

Deno.test("reader: an expired override reads as absent and the exact row is expired", async () => {
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" });
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), null);
  assertEquals(c.calls, ["read", "expire_conversation_mode"]);
  assertEquals(c.stored(), null);
});

Deno.test("reader: a manual row written after the read is not expired and wins", async () => {
  // Between the read and the expiry an operator sets a manual human_first
  // (expires_at null). The expiry matches on the observed expires_at, so it
  // removes nothing; the re-read then honours the operator's row.
  const c = readerClient(
    { ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" },
    { afterFirstRead: () => ({ ...ROW, mode: "human_first", expires_at: null }) },
  );
  assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), "human_first");
  assertEquals(c.calls, ["read", "expire_conversation_mode", "read"]);
  assertEquals(c.stored()?.expires_at, null);
});

Deno.test("reader: a failed expiry fails closed while the expired row is still there", async () => {
  // The expiry RPC is the only thing that leaves the thread marked. When it fails, the
  // marker is not durable, and a turn that goes on as if the window had ended cleanly
  // loses the apology the customer is owed. The turn fails and is retried instead.
  const c = readerClient({ ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" }, { failExpire: true });
  const originalError = console.error;
  const logged: unknown[][] = [];
  console.error = (...args: unknown[]) => { logged.push(args); };
  try {
    await assertRejects(() => resolveConversationOverride(c.admin, SCOPE, NOW), Error, "marker is not durable");
  } finally {
    console.error = originalError;
  }
  assertEquals(logged.length, 1);
  // The row is read again to tell the failures apart.
  assertEquals(c.calls, ["read", "expire_conversation_mode", "read"]);
});

Deno.test("reader: a failed expiry still honours a takeover installed meanwhile", async () => {
  // The expiry failed, but an operator installed a fresh human_first row after the first
  // read. That takeover is real, so the assistant stays silent: reading it as "no
  // override" would let it answer a chat a human has taken.
  const c = readerClient(
    { ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" },
    { failExpire: true, afterFirstRead: () => ({ ...ROW, mode: "human_first", expires_at: null }) },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), "human_first");
  } finally {
    console.error = originalError;
  }
  assertEquals(c.calls, ["read", "expire_conversation_mode", "read"]);
});

Deno.test("reader: a failed expiry that did land reads as no override", async () => {
  // The RPC reported an error, but the write had already happened: the row is gone, so
  // the window really is over and the turn may continue.
  const c = readerClient(
    { ...ROW, mode: "human_first", expires_at: "2026-09-13T09:00:00Z" },
    { failExpire: true, afterFirstRead: () => null },
  );
  const originalError = console.error;
  console.error = () => {};
  try {
    assertEquals(await resolveConversationOverride(c.admin, SCOPE, NOW), null);
  } finally {
    console.error = originalError;
  }
});
