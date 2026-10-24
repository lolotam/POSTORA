import { assertEquals } from "jsr:@std/assert@1";
import {
  auditSchemaRejection,
  confirmField,
  recordForwardedRefusal,
  recordMcpRefusal,
  REFUSAL_THROTTLE_MAX_ENTRIES,
  refuseUnconfirmed,
  refuseUngranted,
  refusalThrottleSizeForTests,
  resetRefusalThrottleForTests,
  type ConfirmRefusal,
  type ScopeRefusal,
} from "./confirmGate.ts";
import type { ScopeGrant } from "./toolScopes.ts";

interface FakeCall {
  method: string;
  args: unknown[];
}

interface FakeQueryBuilder {
  select(columns: string): FakeQueryBuilder;
  eq(column: string, value: unknown): FakeQueryBuilder;
  maybeSingle(): Promise<{ data: unknown; error: { message: string } | null }>;
  insert(row: Record<string, unknown>): Promise<{ error: { message: string } | null }>;
}

interface FakeAdminOptions {
  insertError?: { message: string } | null;
  throwOn?: "insert" | null;
  // The number of inserts that fail with a returned error before one
  // succeeds. The count lives in the closure, not in the options, so the
  // options are never mutated.
  failInserts?: number;
  // The number of inserts that fail with a thrown error before one succeeds.
  throwOnInserts?: number;
  // The first insert stays in flight until the test releases it, so a
  // second refusal can arrive while the first write is still running.
  deferFirstInsert?: boolean;
}

// A fake admin that records every call the gate makes. Nothing here talks to
// a database or to the network. The query methods are there so that a lookup
// the gate must no longer perform would show up in the recorded calls.
function createFakeAdmin(options: FakeAdminOptions = {}) {
  const calls: FakeCall[] = [];
  const inserts: { table: string; row: Record<string, unknown> }[] = [];
  let failingInserts = options.failInserts ?? 0;
  let throwingInserts = options.throwOnInserts ?? 0;
  let deferredInsert: Promise<{ error: { message: string } | null }> | null = null;
  let releaseDeferred: ((result: { error: { message: string } | null }) => void) | null = null;

  const admin = {
    from(table: string): FakeQueryBuilder {
      calls.push({ method: "from", args: [table] });
      const builder: FakeQueryBuilder = {
        select(columns: string) {
          calls.push({ method: "select", args: [columns] });
          return builder;
        },
        eq(column: string, value: unknown) {
          calls.push({ method: "eq", args: [column, value] });
          return builder;
        },
        async maybeSingle() {
          calls.push({ method: "maybeSingle", args: [] });
          return { data: null, error: null };
        },
        async insert(row: Record<string, unknown>) {
          calls.push({ method: "insert", args: [row] });
          if (options.throwOn === "insert") throw new Error("database is down");
          if (throwingInserts > 0) {
            throwingInserts -= 1;
            throw new Error("database is down");
          }
          if (options.deferFirstInsert && deferredInsert === null) {
            // The write stays in flight until the test releases it.
            deferredInsert = new Promise<{ error: { message: string } | null }>(
              (resolve) => {
                releaseDeferred = resolve;
              },
            );
            const result = await deferredInsert;
            // A released write that reports no error landed a row.
            if (result.error === null) inserts.push({ table, row });
            return result;
          }
          if (failingInserts > 0) {
            failingInserts -= 1;
            return { error: { message: "insert failed" } };
          }
          inserts.push({ table, row });
          return { error: options.insertError ?? null };
        },
      };
      return builder;
    },
  };

  return {
    admin,
    calls,
    inserts,
    // Releases the deferred insert with a write that failed.
    releaseDeferredInsert() {
      releaseDeferred?.({ error: { message: "insert failed" } });
    },
    // Releases the deferred insert with a write that landed.
    releaseDeferredInsertSuccess() {
      releaseDeferred?.({ error: null });
    },
  };
}

// A clock the test drives, so the refusal throttle can be exercised without
// waiting for a real minute to pass.
function createClock(start: number) {
  let current = start;
  return {
    now: () => current,
    advance(ms: number) {
      current += ms;
    },
  };
}

// The owner the edge resolved before the tool ran. The gate never resolves
// an owner itself: it is given the id and writes the row under it.
const OWNER_ID = "user-42";

const EXPECTED_REFUSAL: ConfirmRefusal = {
  code: "CONFIRMATION_REQUIRED",
  message: "Set confirm: true to run this action.",
};

Deno.test("the confirm field takes any value, so the handler refuses and records it", () => {
  assertEquals(confirmField.safeParse(true).success, true);
  assertEquals(confirmField.safeParse(false).success, true);
  assertEquals(confirmField.safeParse(undefined).success, true);
  assertEquals(confirmField.safeParse("true").success, true);
  assertEquals(confirmField.safeParse(null).success, true);
});

Deno.test("a confirmed call is allowed and touches no database", async () => {
  const { admin, calls } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: true },
  );

  assertEquals(refusal, null);
  assertEquals(calls, []);
});

Deno.test("a missing confirm is refused and the refusal is recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);

  // The owner is the one the edge resolved. The gate reads no profile: an
  // unauthenticated caller never reaches it.
  assertEquals(calls.map((call) => call.method), ["from", "insert"]);
  assertEquals(calls[0].args, ["system_logs"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "delete_comment refused: CONFIRMATION_REQUIRED",
    user_id: OWNER_ID,
    metadata: {
      tool: "delete_comment",
      code: "CONFIRMATION_REQUIRED",
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  assertEquals("args" in metadata, false);
  assertEquals("arguments" in metadata, false);
  assertEquals("api_key" in inserts[0].row, false);
});

Deno.test("the refusal is recorded under the owner the edge resolved", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: "another-owner", tool: "hide_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, "another-owner");
});

Deno.test("confirm: false is refused and recorded like a missing confirm", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "cancel_scheduled_post", confirm: false },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "cancel_scheduled_post",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test('confirm: "true" (a string) is refused and recorded', async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: "true" },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test("confirm: null is refused and recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: null },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test("a failed log insert still refuses and never throws", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin({ insertError: { message: "insert failed" } });

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
  assertEquals(inserts.length, 1);
});

Deno.test("a throwing log insert still refuses and never throws", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  const refusal = await refuseUnconfirmed(
    { admin },
    { userId: OWNER_ID, tool: "delete_comment", confirm: undefined },
  );

  assertEquals(refusal, EXPECTED_REFUSAL);
});

Deno.test("recordMcpRefusal writes one row naming the tool and the code, and nothing else", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  await recordMcpRefusal(
    { admin },
    { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
  );

  // The owner comes from the edge. The gate reads no profile.
  assertEquals(calls.map((call) => call.method), ["from", "insert"]);
  assertEquals(calls[0].args, ["system_logs"]);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row, {
    source: "mcp",
    category: "edge",
    level: "warn",
    message: "reply_to_message refused: INVALID_MESSAGE",
    user_id: OWNER_ID,
    metadata: {
      tool: "reply_to_message",
      code: "INVALID_MESSAGE",
    },
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  assertEquals("args" in metadata, false);
  assertEquals("arguments" in metadata, false);
  assertEquals("api_key" in inserts[0].row, false);
});

Deno.test("a failed insert in recordMcpRefusal does not throw", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin({ insertError: { message: "insert failed" } });

  let thrown: unknown = null;
  try {
    await recordMcpRefusal(
      { admin },
      { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
  assertEquals(inserts.length, 1);
});

Deno.test("a throwing insert in recordMcpRefusal does not throw", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  let thrown: unknown = null;
  try {
    await recordMcpRefusal(
      { admin },
      { userId: OWNER_ID, tool: "reply_to_message", code: "INVALID_MESSAGE" },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
});

// ── the refusal throttle ──────────────────────────────────────────────────────

// An authenticated client can repeat an invalid call forever. Every refusal
// used to insert a row, so the log grew with the client's patience. At most
// one row per (owner, tool, code) per minute is written now.

Deno.test("the same refusal twice within a minute writes one row", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  clock.advance(30_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  assertEquals(inserts.length, 1);
});

Deno.test("the same refusal after the window writes a second row", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  clock.advance(61_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  assertEquals(inserts.length, 2);
});

Deno.test("a different tool or code within the window writes its own row", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "hide_comment", code: "CONFIRMATION_REQUIRED" },
  );
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "INVALID_MESSAGE" },
  );

  assertEquals(inserts.length, 3);
});

Deno.test("another owner within the window writes its own row", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: "another-owner", tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  assertEquals(inserts.length, 2);
});

Deno.test("a saturated throttle map does not log a new kind of refusal", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  // The map is filled to its bound with distinct kinds of refusal, all of
  // them written at T, so every one of them is inside its window.
  for (let i = 0; i < REFUSAL_THROTTLE_MAX_ENTRIES; i++) {
    await recordMcpRefusal(
      { admin, now: clock.now },
      { userId: OWNER_ID, tool: "delete_comment", code: `CODE_${i}` },
    );
  }
  assertEquals(inserts.length, REFUSAL_THROTTLE_MAX_ENTRIES);
  assertEquals(refusalThrottleSizeForTests(), REFUSAL_THROTTLE_MAX_ENTRIES);

  // (a) A new kind of refusal is not written down: the map is full of
  // entries whose window is still running, and none of them may be evicted
  // to make room for it. The map keeps its size.
  clock.advance(1_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CODE_NEW" },
  );
  assertEquals(inserts.length, REFUSAL_THROTTLE_MAX_ENTRIES);
  assertEquals(refusalThrottleSizeForTests(), REFUSAL_THROTTLE_MAX_ENTRIES);

  // (b) The first key is still throttled: it was not evicted to make room
  // for the newer keys, so the window of its own refusal is still running.
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CODE_0" },
  );
  assertEquals(inserts.length, REFUSAL_THROTTLE_MAX_ENTRIES);

  // (c) Once the windows have passed, an expired entry is evicted to make
  // room and the new kind of refusal is written down. The map stays inside
  // its bound.
  clock.advance(60_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CODE_NEW" },
  );
  assertEquals(inserts.length, REFUSAL_THROTTLE_MAX_ENTRIES + 1);
  assertEquals(
    refusalThrottleSizeForTests() <= REFUSAL_THROTTLE_MAX_ENTRIES,
    true,
  );

  // The map is module state, so the next test starts from a clean slate.
  resetRefusalThrottleForTests();
});

Deno.test("a refusal that waited for a failed write writes its own row", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts, releaseDeferredInsert } = createFakeAdmin({
    deferFirstInsert: true,
  });
  const clock = createClock(1_000_000);

  // The first refusal starts the write and waits for the database.
  const first = recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  // The second refusal arrives while that write is still in flight. It
  // finds the key of the first one, and waits for the write it is
  // throttled by instead of skipping a row that may never be written.
  const second = recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  // The write of the first refusal fails, so no row was written for it.
  releaseDeferredInsert();
  await first;
  await second;

  // The second refusal wrote its own row: two insert calls, one row.
  const insertCalls = calls.filter((call) => call.method === "insert");
  assertEquals(insertCalls.length, 2);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });
});

Deno.test("only one waiter retries a write that failed", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts, releaseDeferredInsert } = createFakeAdmin({
    deferFirstInsert: true,
  });
  const clock = createClock(1_000_000);

  const request = {
    userId: OWNER_ID,
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  };

  // The first refusal starts the write and waits for the database.
  const first = recordMcpRefusal({ admin, now: clock.now }, request);

  // Two more refusals of the same kind arrive while that write is still in
  // flight. They find the key of the first one and wait for the write it
  // is throttled by.
  const second = recordMcpRefusal({ admin, now: clock.now }, request);
  const third = recordMcpRefusal({ admin, now: clock.now }, request);

  // The write of the first refusal fails, so no row was written for it.
  releaseDeferredInsert();

  let thrown: unknown = null;
  try {
    await first;
    await second;
    await third;
  } catch (error) {
    thrown = error;
  }
  assertEquals(thrown, null);

  // Two insert calls in total: the failed one and ONE retry. The waiters
  // re-read the map after every await, so the first one to get there claims
  // the key and the others wait for that write. They do not write over each
  // other, so the minute holds a single row.
  const insertCalls = calls.filter((call) => call.method === "insert");
  assertEquals(insertCalls.length, 2);
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  });

  // The map holds the row that landed, and only that one.
  assertEquals(refusalThrottleSizeForTests(), 1);
});

Deno.test("an expired entry whose write is still in flight does not write a second row", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts, releaseDeferredInsertSuccess } = createFakeAdmin({
    deferFirstInsert: true,
  });
  const clock = createClock(1_000_000);

  const request = {
    userId: OWNER_ID,
    tool: "delete_comment",
    code: "CONFIRMATION_REQUIRED",
  };

  // The edge report of a skipped refusal is captured: the gate reports it
  // in one line.
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map((arg) => String(arg)).join(" "));
  };

  try {
    // The first refusal starts the write and waits for the database.
    const first = recordMcpRefusal({ admin, now: clock.now }, request);

    // The second refusal of the same kind arrives after the window of the
    // first one has passed, while the write of the first one is still in
    // flight: the database stalled for longer than the window.
    clock.advance(61_000);
    const second = recordMcpRefusal({ admin, now: clock.now }, request);

    // The write of the first refusal lands.
    releaseDeferredInsertSuccess();

    let thrown: unknown = null;
    try {
      await first;
      await second;
    } catch (error) {
      thrown = error;
    }
    assertEquals(thrown, null);

    // One insert call in total: the row of the first refusal is the row
    // of this kind of refusal. The second one waited for that write and
    // wrote none of its own.
    const insertCalls = calls.filter((call) => call.method === "insert");
    assertEquals(insertCalls.length, 1);
    assertEquals(inserts.length, 1);
    assertEquals(inserts[0].table, "system_logs");
    assertEquals(inserts[0].row.user_id, OWNER_ID);
    assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
      tool: "delete_comment",
      code: "CONFIRMATION_REQUIRED",
    });

    // The second refusal is reported on the edge, in one line, and names
    // the row that is still being written.
    assertEquals(warnings, [
      "[mcp] delete_comment refused: CONFIRMATION_REQUIRED " +
        "(an earlier row is still being written, not logged again)",
    ]);
  } finally {
    console.warn = originalWarn;
  }
});

Deno.test("a refused insert does not throttle the next identical refusal", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls } = createFakeAdmin({ failInserts: 1 });
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  clock.advance(1_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  // The first insert wrote no row, so the throttle must not remember it:
  // the second refusal inside the window tries the write again.
  const insertCalls = calls.filter((call) => call.method === "insert");
  assertEquals(insertCalls.length, 2);
});

Deno.test("a throwing insert does not throttle the next identical refusal", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls } = createFakeAdmin({ throwOnInserts: 1 });
  const clock = createClock(1_000_000);

  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );
  clock.advance(1_000);
  await recordMcpRefusal(
    { admin, now: clock.now },
    { userId: OWNER_ID, tool: "delete_comment", code: "CONFIRMATION_REQUIRED" },
  );

  // A thrown insert wrote no row either, so the write is tried again.
  const insertCalls = calls.filter((call) => call.method === "insert");
  assertEquals(insertCalls.length, 2);
});

// ── the schema rejection ───────────────────────────────────────────────────────

// The framework validates the arguments against the tool's input schema before
// the handler runs, so a call that does not fit the schema never reaches the
// handler and never reaches the confirmation gate either. The refusal it
// answers with is the only trace of such a call, and it has to leave a row.

const INVALID_PARAMS = -32602;

Deno.test("a schema rejection of a tool call is recorded as a refusal", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: {
          name: "reply_to_message",
          arguments: { social_account_id: "account-1", message: "hello there" },
        },
      },
    },
  );

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_message",
    code: "INVALID_PARAMS",
  });

  const metadata = inserts[0].row.metadata as Record<string, unknown>;
  assertEquals(Object.keys(metadata).sort(), ["code", "tool"]);

  // The arguments are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("arguments"), false);
  assertEquals(serialized.includes("hello there"), false);
  assertEquals(serialized.includes("account-1"), false);
});

Deno.test("a schema rejection is recorded under the owner the edge resolved", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: "another-owner",
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.user_id, "another-owner");
});

Deno.test("a schema rejection of a method that is not a tool call is not recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/list", params: { name: "reply_to_message" } },
    },
  );

  // Nothing is recorded and nothing is read: this is not a rejected tool call.
  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("an error that is not a schema rejection is not recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: -32601, message: "Method not found" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("an error that is not an error object is not recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: "invalid params",
      rpcRequest: {
        method: "tools/call",
        params: { name: "reply_to_message", arguments: {} },
      },
    },
  );

  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a tool name that is not a tool name is recorded as unknown", async () => {
  const cases: { name: string; label: string }[] = [
    { name: "Reply_To_Message", label: "a name that is not lowercase" },
    { name: "reply-to-message", label: "a name that is not a word" },
    { name: "", label: "an empty name" },
    { name: "a".repeat(65), label: "a name that is too long" },
  ];

  for (const testCase of cases) {
    resetRefusalThrottleForTests();
    const { admin, inserts } = createFakeAdmin();

    await auditSchemaRejection(
      { admin },
      {
        userId: OWNER_ID,
        error: { code: INVALID_PARAMS, message: "Invalid params" },
        rpcRequest: {
          method: "tools/call",
          params: { name: testCase.name, arguments: {} },
        },
      },
    );

    // The row names no tool rather than a tool that does not exist.
    assertEquals(inserts.length, 1, testCase.label);
    assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
      tool: "unknown",
      code: "INVALID_PARAMS",
    }, testCase.label);
  }
});

Deno.test("a rejected tool call that names no tool is recorded as unknown", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: { method: "tools/call", params: { arguments: {} } },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "unknown",
    code: "INVALID_PARAMS",
  });
});

Deno.test("a rejected tool call that names a tool nobody registered is recorded as unknown", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await auditSchemaRejection(
    { admin },
    {
      userId: OWNER_ID,
      error: { code: INVALID_PARAMS, message: "Invalid params" },
      rpcRequest: {
        method: "tools/call",
        params: { name: "not_a_real_tool", arguments: {} },
      },
    },
  );

  // The name is well formed, but no tool carries it: the row names no tool
  // rather than a tool that does not exist, so a caller cannot get one row
  // per invented name.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "unknown",
    code: "INVALID_PARAMS",
  });
});

Deno.test("the auditor never throws, whatever the database does", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  let thrown: unknown = null;
  try {
    await auditSchemaRejection(
      { admin },
      {
        userId: OWNER_ID,
        error: { code: INVALID_PARAMS, message: "Invalid params" },
        rpcRequest: {
          method: "tools/call",
          params: { name: "reply_to_message", arguments: {} },
        },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
});

// ── the scope gate ─────────────────────────────────────────────────────────────

// An OAuth token holds only the scopes it was granted. A tool it was not
// granted is refused before it runs, and the refusal leaves a row like every
// other refusal.

const GRANT_WITHOUT_COMMENTS: ScopeGrant = {
  kind: "granted",
  scopes: new Set(["accounts:read", "posts:read", "posts:write", "media:write", "webhooks:manage"]),
};

// A grant that holds neither the comment scopes nor posts:read.
const GRANT_WITHOUT_POSTS_READ: ScopeGrant = {
  kind: "granted",
  scopes: new Set(["accounts:read", "media:write"]),
};

Deno.test("a tool the grant does not cover is refused and the refusal is recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUngranted(
    { admin },
    { userId: OWNER_ID, tool: "hide_comment", grant: GRANT_WITHOUT_COMMENTS },
  );

  // The refusal names the scope that is missing.
  assertEquals(refusal, {
    code: "SCOPE_NOT_GRANTED",
    message:
      "This tool is not available over OAuth yet (it needs the comments:write scope, " +
      "which cannot be granted yet). Use a Postora API key.",
  } as const);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "hide_comment",
    code: "SCOPE_NOT_GRANTED",
  });

  // The scopes and the arguments are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("comments:write"), false);
});

Deno.test("a tool the grant covers is allowed and touches no database", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  const refusal = await refuseUngranted(
    { admin },
    { userId: OWNER_ID, tool: "cancel_scheduled_post", grant: GRANT_WITHOUT_COMMENTS },
  );

  assertEquals(refusal, null);
  assertEquals(inserts.length, 0);
  assertEquals(calls, []);
});

Deno.test("a create_post that uploads media is refused without media:write, and the refusal is recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUngranted(
    { admin },
    {
      userId: OWNER_ID,
      tool: "create_post",
      grant: { kind: "granted", scopes: new Set(["posts:write"]) },
      args: { media_urls: ["https://a"] },
    },
  );

  // The media it uploads lands in the media library, so the grant does not
  // cover the call: the refusal names the scope that is missing.
  assertEquals(refusal?.code, "SCOPE_NOT_GRANTED");
  assertEquals(refusal?.message.includes("media:write"), true);

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "create_post",
    code: "SCOPE_NOT_GRANTED",
  });

  // The arguments are not in the row.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("media_urls"), false);
  assertEquals(serialized.includes("https://a"), false);
});

Deno.test("an API-key grant covers every tool and touches no database", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  const refusal = await refuseUngranted(
    { admin },
    { userId: OWNER_ID, tool: "reply_to_message", grant: { kind: "all" } },
  );

  assertEquals(refusal, null);
  assertEquals(inserts.length, 0);
  assertEquals(calls, []);
});

Deno.test("a scope refusal names the scope the token is missing", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin();

  const refusal: ScopeRefusal | null = await refuseUngranted(
    { admin },
    {
      userId: OWNER_ID,
      tool: "reply_to_message",
      grant: { kind: "granted", scopes: new Set(["posts:read"]) },
    },
  );

  assertEquals(refusal, {
    code: "SCOPE_NOT_GRANTED",
    message:
      "This tool is not available over OAuth yet (it needs the messages:write scope, " +
      "which cannot be granted yet). Use a Postora API key.",
  } as const);
});

Deno.test("a scope that cannot be granted yet is not answered with a dead end", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin();

  const refusal: ScopeRefusal | null = await refuseUngranted(
    { admin },
    { userId: OWNER_ID, tool: "hide_comment", grant: GRANT_WITHOUT_COMMENTS },
  );

  // Reconnecting cannot produce a scope that no token can be granted yet,
  // so the refusal must not send the caller into that circle.
  assertEquals(refusal?.code, "SCOPE_NOT_GRANTED");
  assertEquals(refusal?.message.includes("not available over OAuth yet"), true);
  assertEquals(refusal?.message.includes("Reconnect"), false);
});

Deno.test("a scope that can be granted is still answered with a reconnect", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin();

  const refusal: ScopeRefusal | null = await refuseUngranted(
    { admin },
    { userId: OWNER_ID, tool: "get_media", grant: GRANT_WITHOUT_POSTS_READ },
  );

  // posts:read can be granted, so reconnecting is the advice that works.
  assertEquals(refusal?.code, "SCOPE_NOT_GRANTED");
  assertEquals(refusal?.message.includes("Reconnect"), true);
});

Deno.test("a tool nobody classified is refused without a dead end", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  const refusal = await refuseUngranted(
    { admin },
    {
      userId: OWNER_ID,
      tool: "not_a_registered_tool",
      grant: GRANT_WITHOUT_COMMENTS,
    },
  );

  // Nobody classified the tool, so there is no scope to grant it: a
  // reconnect cannot produce one, and the refusal must not send the caller
  // into that circle.
  assertEquals(refusal, {
    code: "SCOPE_NOT_GRANTED",
    message: "This tool is not available over OAuth. Use a Postora API key.",
  } as const);
  assertEquals(refusal?.message.includes("Reconnect"), false);

  // It still leaves a row, like every other refusal.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "not_a_registered_tool",
    code: "SCOPE_NOT_GRANTED",
  });
});

// ── the forwarded refusal ─────────────────────────────────────────────────────

// Some API routes refuse a call with a 4xx and a body and write no row of
// their own. The MCP tool that forwarded the answer records the refusal, so
// a call that was refused behind the API leaves the same trace a call
// refused here would have left.

Deno.test("a forwarded refusal is recorded under the code the error envelope carries", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  // The API answers a refusal with its error envelope: { success: false,
  // error: { code, message } } (see apiError in ../n8n-api/index.ts).
  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "get_media",
      status: 404,
      data: { success: false, error: { code: "MEDIA_NOT_FOUND", message: "x" } },
    },
  );

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "get_media",
    code: "MEDIA_NOT_FOUND",
  });
});

Deno.test("a forwarded refusal is recorded under the code of the envelope, not under the status", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  // A comment action the platform refused: a 422 carrying its own code.
  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "reply_to_comment",
      status: 422,
      data: { success: false, error: { code: "COMMENT_ACTION_FAILED", message: "x" } },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_comment",
    code: "COMMENT_ACTION_FAILED",
  });
});

Deno.test("a forwarded refusal whose envelope code is not shaped like a code is recorded under its status", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "hide_comment",
      status: 422,
      data: { success: false, error: { code: "bad code!", message: "x" } },
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "hide_comment",
    code: "HTTP_422",
  });
});

Deno.test("two forwarded refusals with the same status but different codes write their own rows", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();
  const clock = createClock(1_000_000);

  // Both answers carry a 422, but they are two different refusals: the code
  // the API named them with is what tells them apart, so they do not share a
  // throttle key and one of them does not swallow the other.
  await recordForwardedRefusal(
    { admin, now: clock.now },
    {
      userId: OWNER_ID,
      tool: "reply_to_comment",
      status: 422,
      data: { success: false, error: { code: "COMMENT_ACTION_FAILED", message: "x" } },
    },
  );
  await recordForwardedRefusal(
    { admin, now: clock.now },
    {
      userId: OWNER_ID,
      tool: "reply_to_comment",
      status: 422,
      data: { success: false, error: { code: "COMMENT_NOT_FOUND", message: "x" } },
    },
  );

  assertEquals(inserts.length, 2);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "reply_to_comment",
    code: "COMMENT_ACTION_FAILED",
  });
  assertEquals(inserts[1].row.metadata as Record<string, unknown>, {
    tool: "reply_to_comment",
    code: "COMMENT_NOT_FOUND",
  });
});

Deno.test("a forwarded 404 is recorded under the code the body carries", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await recordForwardedRefusal(
    { admin },
    { userId: OWNER_ID, tool: "get_media", status: 404, data: { code: "MEDIA_NOT_FOUND" } },
  );

  // One row, naming the tool and the code and nothing else.
  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].table, "system_logs");
  assertEquals(inserts[0].row.user_id, OWNER_ID);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "get_media",
    code: "MEDIA_NOT_FOUND",
  });
});

Deno.test("a forwarded refusal whose code is not shaped like a code is recorded under its status", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await recordForwardedRefusal(
    { admin },
    { userId: OWNER_ID, tool: "hide_comment", status: 400, data: { code: "bad code!" } },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "hide_comment",
    code: "HTTP_400",
  });
});

Deno.test("a forwarded refusal whose body is not an object is recorded under its status", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "delete_comment",
      status: 400,
      data: "that comment does not exist",
    },
  );

  assertEquals(inserts.length, 1);
  assertEquals(inserts[0].row.metadata as Record<string, unknown>, {
    tool: "delete_comment",
    code: "HTTP_400",
  });
});

Deno.test("a forwarded 429 is not recorded: the API's central limiter records it", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  // The API's rate limiter answers a 429 before the route behind the tool
  // runs, and it records the refusal itself (see recordRateLimitRefusal in
  // ../n8n-api/refusalLog.ts). Recording it here as well would write the
  // same refusal twice.
  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "reply_to_message",
      status: 429,
      data: { success: false, error: { code: "RATE_LIMIT_EXCEEDED", message: "x" } },
    },
  );

  // No row, and not even a lookup: the refusal behind this answer is on
  // record already.
  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("a forwarded answer that is not a refusal is not recorded", async () => {
  resetRefusalThrottleForTests();
  const { admin, calls, inserts } = createFakeAdmin();

  // A 2xx is a call that ran, and a 5xx is an outage of the API: neither is
  // a refusal, so neither is written down.
  await recordForwardedRefusal(
    { admin },
    { userId: OWNER_ID, tool: "get_media", status: 200, data: { id: "media-file-1" } },
  );
  await recordForwardedRefusal(
    { admin },
    { userId: OWNER_ID, tool: "get_media", status: 502, data: { error: "bad gateway" } },
  );

  assertEquals(inserts.length, 0);
  assertEquals(calls.length, 0);
});

Deno.test("the body of a forwarded refusal is never written down", async () => {
  resetRefusalThrottleForTests();
  const { admin, inserts } = createFakeAdmin();

  await recordForwardedRefusal(
    { admin },
    {
      userId: OWNER_ID,
      tool: "get_media",
      status: 404,
      data: {
        code: "MEDIA_NOT_FOUND",
        message: "no media file with that id",
        media_id: "media-file-7",
      },
    },
  );

  // The code is written down, the body is not: it may name the account, the
  // comment or the media the caller asked for.
  const serialized = JSON.stringify(inserts[0].row);
  assertEquals(serialized.includes("no media file"), false);
  assertEquals(serialized.includes("media-file-7"), false);
  assertEquals(serialized.includes("media_id"), false);
});

Deno.test("a forwarded refusal never throws, whatever the database does", async () => {
  resetRefusalThrottleForTests();
  const { admin } = createFakeAdmin({ throwOn: "insert" });

  let thrown: unknown = null;
  try {
    await recordForwardedRefusal(
      { admin },
      {
        userId: OWNER_ID,
        tool: "hide_comment",
        status: 400,
        data: { code: "COMMENT_NOT_FOUND" },
      },
    );
  } catch (error) {
    thrown = error;
  }

  assertEquals(thrown, null);
});
