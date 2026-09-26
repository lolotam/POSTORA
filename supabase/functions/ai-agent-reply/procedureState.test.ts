import { assertEquals } from "jsr:@std/assert@1";
import { persistProcedureState } from "./procedureState.ts";

// A boundary fake for PostgREST: it records the predicate and answers like the database.
function fakeDb(result: { data: unknown[] | null; error: { message: string } | null }) {
  const filters: string[] = [];
  const filter = {
    eq(column: string, value: string) { filters.push(`${column}=eq.${value}`); return filter; },
    is(column: string, _value: null) { filters.push(`${column}=is.null`); return filter; },
    select(_columns: "id") { return Promise.resolve(result); },
  };
  return { db: { from: (_table: "ai_threads") => ({ update: (_values: { procedure_state: unknown }) => filter }) }, filters };
}

Deno.test("the write is guarded by the state this turn read", async () => {
  const { db, filters } = fakeDb({ data: [{ id: "t1" }], error: null });
  assertEquals(await persistProcedureState(db, "t1", { run_id: "r", step: 1 }, null), true);
  assertEquals(filters, ["id=eq.t1", 'procedure_state=eq.{"run_id":"r","step":1}']);
});

Deno.test("a turn that read no state only writes over no state", async () => {
  const { db, filters } = fakeDb({ data: [{ id: "t1" }], error: null });
  await persistProcedureState(db, "t1", null, { run_id: "r" });
  assertEquals(filters[1], "procedure_state=is.null");
});

for (const [label, result] of [
  ["a concurrent turn changed the state first (no row matched)", { data: [], error: null }],
  ["the database rejected the write", { data: null, error: { message: "boom" } }],
] as const) {
  Deno.test(`persistProcedureState reports failure when ${label}`, async () => {
    const { db } = fakeDb(result);
    assertEquals(await persistProcedureState(db, "t1", null, { run_id: "r" }), false);
  });
}
