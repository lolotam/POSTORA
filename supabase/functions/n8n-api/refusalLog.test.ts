import { assertEquals } from "jsr:@std/assert@1";
import { recordApiRefusal } from "./refusalLog.ts";

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

function capturedError(run: () => Promise<void>): Promise<string[]> {
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
