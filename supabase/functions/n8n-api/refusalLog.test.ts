import { assertEquals } from "jsr:@std/assert@1";
import {
  RATE_LIMIT_REFUSAL_DEADLINE_MS,
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

// A client that never answers: the database is the thing that is slow, which
// is exactly the pressure that caused the throttling in the first place. The
// insert is attempted and then left hanging, the way a hung query behaves,
// until the test releases it.
class HangingSupabase {
  attempts = 0;
  landed = false;
  private release: (() => void) | null = null;

  from(_table: string) {
    const db = this;
    return {
      insert(_payload: unknown): Promise<{ data: null; error: null }> {
        db.attempts += 1;
        const hung = new Promise<{ data: null; error: null }>((resolve) => {
          db.release = () => resolve({ data: null, error: null });
        });
        hung.then(
          () => {
            db.landed = true;
          },
          () => {
            db.landed = true;
          },
        );
        return hung;
      },
    };
  }

  // Lets the hung insert land, the way a slow row eventually does.
  releaseInsert(): void {
    this.release?.();
    this.release = null;
  }
}

// A client that fails the first write and works after that: the refusal row
// has to be written on the next attempt, because a throttle entry that stands
// for a row nobody can see would suppress every identical refusal of the next
// minute with no row at all.
class FlakySupabase {
  attempts = 0;

  constructor(private readonly failures: number) {}

  from(_table: string) {
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

// The throttle stands for a row that is really there. A row that was not
// written is not a row, and an entry that stands for one suppresses every
// identical refusal of the next minute with no trace at all.

Deno.test("a refusal row that landed is not written again inside the window", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FakeSupabase();

  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 });
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_030_000 });

  // The row landed, so the window holds: the second refusal inside it is
  // suppressed instead of written again.
  assertEquals(db.inserts.length, 1);
});

Deno.test("a refusal row that did not land is written again inside the window", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new FlakySupabase(1);

  const logged = await capturedError(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000 })
  );

  // The first write failed, so there is no row behind the first refusal.
  assertEquals(db.attempts, 1);
  assertEquals(logged.length, 1);
  assertEquals(logged[0].includes(ROUTE), true);

  // The throttle entry that stood for the missing row is released, so the next
  // identical refusal inside the window writes its own row instead of being
  // suppressed with no trace at all.
  await recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_030_000 });
  assertEquals(db.attempts, 2);
});

Deno.test("a refusal row that never landed keeps the entry, so a hanging database is not hammered", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new HangingSupabase();

  // The deadline wins: the write has not finished, so whether it lands is not
  // known yet.
  await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000, deadlineMs: 20 })
  );
  await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_030_000, deadlineMs: 20 })
  );

  // The second refusal inside the window did not insert again: a database that
  // hangs must not turn every 429 into a new insert.
  assertEquals(db.attempts, 1);
  db.releaseInsert();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
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

// The refusal row is the trace; the 429 is the answer. The two cannot be
// allowed to wait on each other: the database that hangs under the pressure
// that caused the throttling would otherwise cost the caller its 429, and a
// caller that gets an edge timeout instead of its refusal cannot tell a
// throttled request from a broken one.

Deno.test("a refusal row that never lands does not hold the 429 past its deadline", async () => {
  resetRateLimitRefusalThrottleForTests();
  const db = new HangingSupabase();

  // The deadline is the documented one: two seconds.
  assertEquals(RATE_LIMIT_REFUSAL_DEADLINE_MS, 2_000);

  const started = Date.now();
  const warned = await capturedWarn(() =>
    recordRateLimitRefusal(db, { userId: USER, route: ROUTE, now: 1_000_000, deadlineMs: 20 })
  );
  const elapsed = Date.now() - started;

  // The refusal was answered: the call resolved on its own, well inside the
  // deadline the caller would otherwise have waited for.
  assertEquals(elapsed < RATE_LIMIT_REFUSAL_DEADLINE_MS, true);
  // The insert was attempted once, and it was left to finish on its own
  // rather than cancelled: a slow row still lands.
  assertEquals(db.attempts, 1);
  db.releaseInsert();
  await new Promise<void>((resolve) => setTimeout(() => resolve(), 0));
  assertEquals(db.landed, true);
  // The wait is not silent: one line names the route and the deadline.
  assertEquals(warned.length, 1);
  assertEquals(warned[0].includes(ROUTE), true);
  assertEquals(warned[0].includes("20ms"), true);
});
