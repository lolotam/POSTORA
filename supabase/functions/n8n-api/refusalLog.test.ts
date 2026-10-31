import { assertEquals } from "jsr:@std/assert@1";
import {
  recordApiRefusal,
  recordRateLimitRefusal,
  resetRateLimitRefusalThrottleForTests,
} from "./refusalLog.ts";

const USER = "11111111-1111-4111-8111-111111111111";
const ACCOUNT = "33333333-3333-4333-8333-333333333333";
const POST = "22222222-2222-4222-8222-222222222222";
const ROUTE = "messages/reply";

// A refusal is a decision, not a fault, but it still has to leave a trace: a
// refusal nobody watched is a refusal nobody can explain later. The row is the
// record of it, so these tests read what was written.

interface RecordedInsert {
  table: string;
  payload: Record<string, unknown>;
}

class FakeSupabase {
  readonly inserts: RecordedInsert[] = [];

  constructor(private readonly error: { message: string } | null = null) {}

  from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the nested fake methods are regular functions and need the outer instance
    const db = this;
    return {
      insert(payload: Record<string, unknown>) {
        db.inserts.push({ table, payload });
        return Promise.resolve({ data: null, error: db.error });
      },
    };
  }
}

// A client that fails loudly: a refusal that cannot be recorded still has to
// answer the caller.
class ThrowingSupabase {
  from(_table: string) {
    return {
      insert(_payload: unknown): Promise<never> {
        return Promise.reject(new Error("the database is unreachable"));
      },
    };
  }
}

// A client that fails the first write and works after that: the refusal row
// has to be written on the next attempt, because a write that did not land is
// not remembered. The claim of a failed write is released, so a failed write
// leaves nothing behind and the next identical refusal tries again.
class FlakySupabase {
  attempts = 0;

  constructor(private readonly failures: number) {}

  from(_table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the nested fake methods are regular functions and need the outer instance
    const db = this;
    return {
      insert(_payload: unknown): Promise<{ data: null; error: { message: string } | null }> {
        db.attempts += 1;
        const error = db.attempts <= db.failures ? { message: "insert failed" } : null;
        return Promise.resolve({ data: null, error });
      },
    };
  }
}

// A client whose first write is held open on a controlled promise: the insert
// is still in flight when the next refusal arrives, which is exactly the
// burst an in-flight claim has to stop. The insert calls are counted apart
// from the rows, because a burst that schedules three writes and lands one
// row is still three writes.
class HeldSupabase {
  readonly inserts: RecordedInsert[] = [];
  insertCalls = 0;
  private releaseFn: ((result: { data: null; error: { message: string } | null }) => void) | null = null;
  private holding = false;

  from(table: string) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias -- the nested fake methods are regular functions and need the outer instance
    const db = this;
    return {
      insert(payload: Record<string, unknown>): Promise<{ data: null; error: { message: string } | null }> {
        db.insertCalls += 1;
        db.inserts.push({ table, payload });
        if (db.holding) return Promise.resolve({ data: null, error: null });
        db.holding = true;
        return new Promise<{ data: null; error: { message: string } | null }>((resolve) => {
          db.releaseFn = resolve;
        });
      },
    };
  }

  // Releases the held write. An error makes that write fail, so its row does
  // not land.
  release(error: { message: string } | null = null): void {
    this.releaseFn?.({ data: null, error });
  }
}

function capturedError(run: () => Promise<unknown>): Promise<string[]> {
  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  return run()
    .then(() => logged)
    .finally(() => {
      console.error = originalError;
    });
}

function capturedWarn(run: () => Promise<unknown>): Promise<string[]> {
  const logged: string[] = [];
  const originalWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    logged.push(args.map(String).join(" "));
  };
  return run()
    .then(() => logged)
    .finally(() => {
      console.warn = originalWarn;
    });
}

Deno.test("a refusal leaves one durable row with the route, the code and the status", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "INVALID_MESSAGE",
    status: 400,
  });

  assertEquals(db.inserts.length, 1);
  assertEquals(db.inserts[0].table, "system_logs");
  const row = db.inserts[0].payload;
  assertEquals(row.source, "n8n-api");
  // The category has to be one the column accepts: system_logs_category_check
  // rejects anything outside auth, edge, database, token, post, system, ai,
  // scheduler, webhook, payment and media.
  assertEquals(row.category, "edge");
  assertEquals(row.level, "warn");
  assertEquals(row.message, "messages/reply refused: INVALID_MESSAGE");
  assertEquals(row.user_id, USER);
  assertEquals(row.metadata, {
    route: ROUTE,
    code: "INVALID_MESSAGE",
    status: 400,
  });
});

Deno.test("the row carries nothing but the route, the code, the status and the ids", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "ACCOUNT_NOT_FOUND",
    status: 404,
    accountId: ACCOUNT,
  });

  const row = db.inserts[0].payload;
  assertEquals(Object.keys(row).sort(), [
    "category",
    "level",
    "message",
    "metadata",
    "source",
    "user_id",
  ]);
  // The account id is written down, because it is a real uuid.
  assertEquals(row.metadata, {
    route: ROUTE,
    code: "ACCOUNT_NOT_FOUND",
    status: 404,
    account_id: ACCOUNT,
  });
});

Deno.test("an account id that is not a uuid is not written down", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "INVALID_ACCOUNT_ID",
    status: 400,
    accountId: "not-a-uuid",
  });

  const row = db.inserts[0].payload;
  const metadata = row.metadata as Record<string, unknown>;
  assertEquals("account_id" in metadata, false);
  // The id the caller made up never reaches the log, in any form.
  assertEquals(JSON.stringify(row).includes("not-a-uuid"), false);
});

Deno.test("a post id is written down as metadata.post_id", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "POST_NOT_FOUND",
    status: 404,
    postId: POST,
  });

  const row = db.inserts[0].payload;
  // The post id is written down, because it is a real uuid.
  assertEquals(row.metadata, {
    route: ROUTE,
    code: "POST_NOT_FOUND",
    status: 404,
    post_id: POST,
  });
});

Deno.test("a post id that is not a uuid is not written down", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "INVALID_POST_ID",
    status: 400,
    postId: "not-a-uuid",
  });

  const row = db.inserts[0].payload;
  const metadata = row.metadata as Record<string, unknown>;
  assertEquals("post_id" in metadata, false);
  // The id the caller made up never reaches the log, in any form.
  assertEquals(JSON.stringify(row).includes("not-a-uuid"), false);
});

Deno.test("a refusal without a post id writes no post_id key", async () => {
  const db = new FakeSupabase();
  await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "INVALID_MESSAGE",
    status: 400,
  });

  const row = db.inserts[0].payload;
  const metadata = row.metadata as Record<string, unknown>;
  assertEquals("post_id" in metadata, false);
});

Deno.test("a row that cannot be written leaves a log line and never throws", async () => {
  const db = new FakeSupabase({ message: "insert failed" });
  const logged = await capturedError(() =>
    recordApiRefusal(db, {
      userId: USER,
      route: ROUTE,
      code: "INVALID_MESSAGE",
      status: 400,
    })
  );

  // The refusal is still a refusal: the edge log is the only sink left when
  // the database refuses the row, and it names the route and the code.
  assertEquals(logged.length, 1);
  assertEquals(logged[0].includes(ROUTE), true);
  assertEquals(logged[0].includes("INVALID_MESSAGE"), true);
});

Deno.test("a client that throws never takes the refusal down with it", async () => {
  const logged = await capturedError(() =>
    recordApiRefusal(new ThrowingSupabase(), {
      userId: USER,
      route: ROUTE,
      code: "INVALID_MEDIA",
      status: 400,
    })
  );

  assertEquals(logged.length, 1);
  assertEquals(logged[0].includes(ROUTE), true);
  assertEquals(logged[0].includes("INVALID_MEDIA"), true);
});

// The writer answers whether the row landed. A caller that only wants the
// refusal recorded can ignore the answer, but the throttled writer cannot: a
// refusal row that was never written may not be throttled away.

Deno.test("a refusal that was written says so", async () => {
  const db = new FakeSupabase();
  const landed = await recordApiRefusal(db, {
    userId: USER,
    route: ROUTE,
    code: "INVALID_MESSAGE",
    status: 400,
  });

  assertEquals(landed, true);
});

Deno.test("a refusal that could not be written says so", async () => {
  const db = new FakeSupabase({ message: "insert failed" });
  let failed = true;
  const logged = await capturedError(async () => {
    failed = await recordApiRefusal(db, {
      userId: USER,
      route: ROUTE,
      code: "INVALID_MESSAGE",
      status: 400,
    });
  });

  // The insert was refused: there is no row, and the edge log says so.
  assertEquals(logged.length, 1);
  assertEquals(failed, false);
});

Deno.test("a refusal whose client threw says so", async () => {
  let failed = true;
  const logged = await capturedError(async () => {
    failed = await recordApiRefusal(new ThrowingSupabase(), {
      userId: USER,
      route: ROUTE,
      code: "INVALID_MEDIA",
      status: 400,
    });
  });

  assertEquals(logged.length, 1);
  assertEquals(failed, false);
});

// The central limiter answers before any route runs, so the throttled refusal
// is recorded by the limiter itself. A client that exhausts its quota is
// hammering the API by definition, so the row is throttled: one row per user
// and route per minute is enough to leave the trace without amplifying the
// writes exactly when the database is under pressure.

Deno.test("a throttled refusal leaves one row per user and route per minute", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();

  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 });
  const warned = await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_030_000 })
  );

  // The second refusal inside the window is not written again: the first one
  // already left the trace.
  assertEquals(db.inserts.length, 1);
  assertEquals(db.inserts[0].table, "system_logs");
  const row = db.inserts[0].payload;
  assertEquals(row.message, `${ROUTE} refused: RATE_LIMIT_EXCEEDED`);
  assertEquals(row.user_id, USER);
  assertEquals(row.metadata, {
    route: ROUTE,
    code: "RATE_LIMIT_EXCEEDED",
    status: 429,
  });
  // The skip is not silent: one line names the refusal that was not written.
  assertEquals(warned.length, 1);
  assertEquals(warned[0].includes(ROUTE), true);
});

Deno.test("a throttled refusal is recorded again once the window has passed", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();

  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 });
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_061_000 });

  assertEquals(db.inserts.length, 2);
});

// The throttle entry stands for a row that is really there: it is claimed
// before the write starts, and only the write that claimed it may settle the
// claim. A row that was not written is not a row, and its claim is released,
// so the next identical refusal tries again.

Deno.test("a refusal row that landed is not written again inside the window", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();

  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 });
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_030_000 });
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_059_000 });

  // The row landed, so the window holds: the refusals inside it are
  // suppressed instead of written again.
  assertEquals(db.inserts.length, 1);
});

Deno.test("a refusal row that did not land leaves no entry, so the next refusal writes again", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FlakySupabase(1);

  const logged = await capturedError(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 })
  );

  // The first write failed, so there is no row behind the first refusal.
  assertEquals(db.attempts, 1);
  assertEquals(logged.length, 1);
  assertEquals(logged[0].includes(ROUTE), true);

  // The failure left no throttle entry behind, so the identical refusal
  // writes its row again right away instead of being suppressed by an entry
  // that stands for a row nobody can see.
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_001_000 });
  assertEquals(db.attempts, 2);
});

// The claim is taken before the write starts, and it is taken synchronously:
// a burst of identical refusals must not each schedule a row, because the
// refusals that arrive while the first write is in flight find the claim.
// A claim that is not settled by its own write is left alone, so a write
// that failed late never drops the claim of a later one.

Deno.test("a burst of identical refusals writes one row, not one row per refusal", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new HeldSupabase();
  const T = 1_000_000;

  // The first refusal claims the key and starts a write that is held open.
  const first = recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T });
  assertEquals(db.insertCalls, 1);

  // The rest of the burst arrives while that write is still in flight.
  const warned = await capturedWarn(async () => {
    await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T + 5 });
    await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T + 9 });
  });

  // The claim of the first refusal stopped the burst: one insert call, and
  // the refusals that were skipped say so instead of disappearing.
  assertEquals(db.insertCalls, 1);
  assertEquals(warned.length, 2);
  assertEquals(warned[0].includes(ROUTE), true);

  // The held write lands, and the burst left exactly one row behind.
  db.release();
  await first;
  assertEquals(db.inserts.length, 1);
  assertEquals(db.inserts[0].payload.message, `${ROUTE} refused: RATE_LIMIT_EXCEEDED`);
});

// The window runs from the completion of the write, not from its start: a
// slow row must not leave behind a window that is already half spent, and a
// refusal that arrives while the row is still being written must not be
// answered by a window that opened before the row existed.

Deno.test("a slow write starts the window at its completion, not at its start", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new HeldSupabase();
  const T = 1_000_000;
  let completedAt = T + 90_000;
  const clock = () => completedAt;

  // The write starts at T and is held open for ninety seconds.
  const first = recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T, clock });
  assertEquals(db.insertCalls, 1);

  // The row lands ninety seconds later: the window opens there, not at T.
  db.release();
  await first;

  // A refusal a hundred seconds after the start is inside the window,
  // because the window only opened when the row landed.
  const warned = await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T + 100_000, clock })
  );
  assertEquals(db.insertCalls, 1);
  assertEquals(warned.length, 1);
  assertEquals(warned[0].includes(ROUTE), true);

  // A refusal after the window has passed writes its row again.
  completedAt = T + 151_000;
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: T + 151_000, clock });
  assertEquals(db.insertCalls, 2);
});

Deno.test("a different route gets its own row inside the same window", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();
  const otherRoute = "posts/cancel";

  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 });
  await recordRateLimitRefusal(db, { userId: USER, route: otherRoute, now: 1_030_000 });

  // The throttle is per user and route: exhausting one route's quota says
  // nothing about another one.
  assertEquals(db.inserts.length, 2);
  const metadata = db.inserts[1].payload.metadata as Record<string, unknown>;
  assertEquals(metadata.route, otherRoute);
  assertEquals(metadata.code, "RATE_LIMIT_EXCEEDED");
  assertEquals(metadata.status, 429);
});

// The map is bounded, so one isolate cannot be filled by a client that
// throttles on many routes. When every entry is still inside its window, the
// refusal that finds the map full is not written at all.

Deno.test("the throttle map is bounded: a refusal that finds only live entries is not written", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();

  // One live entry per route: the map is full and every entry is inside its
  // own window.
  for (let i = 0; i < 10_000; i += 1) {
    await recordRateLimitRefusal(db, { userId: USER, route: `${ROUTE}/${i}`, now: 1_000_000 });
  }
  assertEquals(db.inserts.length, 10_000);

  // The map holds only live entries, so this refusal is not written: the
  // bound holds and the writes are not amplified beyond it.
  const warned = await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: `${ROUTE}/new`, now: 1_000_000 })
  );
  assertEquals(db.inserts.length, 10_000);
  assertEquals(warned.length, 1);
  assertEquals(warned[0].includes(ROUTE), true);

  // The map is left as the test found it.
  resetRateLimitRefusalThrottleForTests();
});

// The refusal row is the trace; the 429 is the answer. The two cannot be
// allowed to wait on each other: the database that hangs under the pressure
// that caused the throttling would otherwise cost the caller its 429, and a
// caller that gets an edge timeout instead of its refusal cannot tell a
// throttled request from a broken one. The row is therefore written off the
// response path, through runInBackground, and not against a deadline of its
// own.

Deno.test("tripwire: the refusal row is written off the response path, not against a deadline", () => {
  const source = recordRateLimitRefusal.toString();

  // The write is detached through the shared background helper: waitUntil on
  // the normal runtime, a 2s cap on the degraded path.
  assertEquals(source.includes("runInBackground("), true);
  // The own deadline race is gone: there is no deadline left to win, and no
  // option to shorten one.
  assertEquals(source.includes("deadlineMs"), false);
});
