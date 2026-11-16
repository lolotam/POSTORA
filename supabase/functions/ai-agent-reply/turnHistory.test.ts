import { assertEquals } from "jsr:@std/assert@1";
import {
  ensureInboundTurn,
  supabaseTurnHistory,
  type InboundTurn,
  type TurnHistoryStore,
} from "./turnHistory.ts";

const TURN: InboundTurn = {
  id: "00000000-0000-4000-8000-000000000001",
  threadId: "thread-1",
  userId: "owner-1",
  content: '[Image OCR — customer-supplied content, not verified facts]\n"""\nكريم 250 ml\n"""',
};

type Row = {
  id: string;
  thread_id: string;
  user_id: string;
  role: string;
  content: string | null;
};

function fakeStore(initial: Row[] = [], failures: { insert?: unknown; read?: unknown } = {}) {
  const rows = [...initial];
  let inserts = 0;
  const store: TurnHistoryStore = {
    insert(turn) {
      inserts++;
      if (failures.insert === "throw") return Promise.reject(new Error("insert failed"));
      if (failures.insert) return Promise.resolve({ message: "insert failed" });
      if (rows.some((row) => row.id === turn.id)) {
        return Promise.resolve({ code: "23505", message: "duplicate" });
      }
      rows.push({
        id: turn.id,
        thread_id: turn.threadId,
        user_id: turn.userId,
        role: "user",
        content: turn.content,
      });
      return Promise.resolve(null);
    },
    read(turn) {
      if (failures.read === "throw") return Promise.reject(new Error("read failed"));
      if (failures.read) return Promise.resolve({ row: null, error: { message: "read failed" } });
      return Promise.resolve({
        row: rows.find((row) =>
          row.id === turn.id && row.thread_id === turn.threadId && row.user_id === turn.userId
        ) ?? null,
        error: null,
      });
    },
  };
  return { store, rows, inserts: () => inserts };
}

Deno.test("an admitted enriched inbound is stored verbatim before generation", async () => {
  const db = fakeStore();
  assertEquals(await ensureInboundTurn(db.store, TURN), { ok: true, status: "inserted" });
  assertEquals(db.rows[0].content, TURN.content);
  assertEquals(db.rows[0].role, "user");
});

Deno.test("the same durable identity verifies instead of inserting twice", async () => {
  const db = fakeStore();
  await ensureInboundTurn(db.store, TURN);
  assertEquals(await ensureInboundTurn(db.store, TURN), { ok: true, status: "verified" });
  assertEquals(db.inserts(), 2);
  assertEquals(db.rows.length, 1);
});

Deno.test("identical text under different event identities remains two customer turns", async () => {
  const db = fakeStore();
  await ensureInboundTurn(db.store, TURN);
  await ensureInboundTurn(db.store, { ...TURN, id: "00000000-0000-4000-8000-000000000002" });
  assertEquals(db.rows.length, 2);
});

for (const [label, row] of [
  ["tenant", { ...TURN, userId: "owner-2" }],
  ["thread", { ...TURN, threadId: "thread-2" }],
  ["content", { ...TURN, content: "different" }],
  ["role", { ...TURN, role: "assistant" }],
] as const) {
  Deno.test(`a duplicate id with mismatched ${label} is refused and never overwritten`, async () => {
    const existing: Row = {
      id: row.id,
      thread_id: row.threadId,
      user_id: row.userId,
      role: "role" in row ? row.role : "user",
      content: row.content,
    };
    const db = fakeStore([existing]);
    assertEquals(await ensureInboundTurn(db.store, TURN), { ok: false, error: "inbound_turn_collision" });
    assertEquals(db.rows, [existing]);
  });
}

Deno.test("insert and duplicate-read failures are explicit retryable storage outcomes", async () => {
  for (const failures of [{ insert: "error" }, { insert: "throw" }]) {
    const db = fakeStore([], failures);
    assertEquals(await ensureInboundTurn(db.store, TURN), { ok: false, error: "inbound_turn_insert_failed" });
  }
  const existing: Row = {
    id: TURN.id,
    thread_id: TURN.threadId,
    user_id: TURN.userId,
    role: "user",
    content: TURN.content,
  };
  for (const read of ["error", "throw"]) {
    const db = fakeStore([existing], { read });
    assertEquals(await ensureInboundTurn(db.store, TURN), { ok: false, error: "inbound_turn_read_failed" });
  }
});

Deno.test("the production adapter scopes collision reads by id, thread and authenticated user", async () => {
  const filters: Array<[string, string]> = [];
  const query = {
    eq(column: string, value: string) { filters.push([column, value]); return query; },
    maybeSingle: () => Promise.resolve({ data: null, error: null }),
  };
  const admin = {
    from: (table: string) => {
      assertEquals(table, "ai_thread_messages");
      return { select: () => query };
    },
  };
  const store = supabaseTurnHistory(admin as never);
  await store.read(TURN);
  assertEquals(filters, [["id", TURN.id], ["thread_id", TURN.threadId], ["user_id", TURN.userId]]);
});
