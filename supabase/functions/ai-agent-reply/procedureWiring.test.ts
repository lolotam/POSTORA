// supabase/functions/ai-agent-reply/procedureWiring.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { expireIfStale } from "../_shared/procedures/engine.ts";
import { EVENT_STALE_AFTER_MS, STALE_AFTER_MS } from "../_shared/procedures/templates.ts";
import { iterationBudget, procedureStateAfterTurn, procedureStoreTool } from "./logic.ts";
import { persistProcedureState } from "./procedureState.ts";
import { createProcedureTurn, type ProcedurePorts } from "./procedureRuntime.ts";

const now = new Date("2026-09-26T10:00:00Z");
const active = {
  run_id: "r", key: "booking" as const, version: 1, step: 1, fields: { service: "cut" }, off_script: 0,
  origin: "jev" as const, started_at: now.toISOString(), updated_at: now.toISOString(),
};
const base = { hadTurn: true, storedState: active, initialState: active, turnState: active, progressed: false, escalated: false, now };

for (const [label, overrides, expected] of [
  ["an idle DM with nothing stored writes nothing", { storedState: null, initialState: null, turnState: null }, undefined],
  ["no procedure turn and nothing stored writes nothing", { hadTurn: false, storedState: null, initialState: null, turnState: null }, undefined],
  ["no procedure turn with a stored state clears it", { hadTurn: false, turnState: null }, null],
  ["an escalation clears the flow", { escalated: true }, null],
  ["progress keeps the new state", { progressed: true }, active],
  ["a completed flow clears", { progressed: true, turnState: null }, null],
  ["a pending store-event opener is never rewritten, even without a turn", {
    hadTurn: false, storedState: { ...active, origin: "event", phase: "pending_opener" }, turnState: null,
  }, undefined],
  ["a pending opener survives a turn that would clear it", {
    escalated: true, storedState: { ...active, origin: "event", phase: "pending_opener" },
  }, undefined],
] as const) {
  Deno.test(`procedureStateAfterTurn: ${label}`, () => {
    assertEquals(procedureStateAfterTurn({ ...base, ...overrides } as never), expected);
  });
}

const staleOpener = {
  ...active,
  origin: "event" as const,
  phase: "pending_opener" as const,
  updated_at: new Date(now.getTime() - EVENT_STALE_AFTER_MS - 1).toISOString(),
};
const freshOpener = { ...active, origin: "event" as const, phase: "pending_opener" as const };

Deno.test("procedureStateAfterTurn clears a stale pending opener and leaves a fresh one", () => {
  assertEquals(procedureStateAfterTurn({ ...base, hadTurn: false, storedState: freshOpener, initialState: null, turnState: null }), undefined);
  assertEquals(procedureStateAfterTurn({ ...base, hadTurn: false, storedState: staleOpener, initialState: null, turnState: null }), null);
  assertEquals(procedureStateAfterTurn({
    ...base, hadTurn: false, storedState: { ...freshOpener, origin: "jev", updated_at: new Date(now.getTime() - STALE_AFTER_MS - 1).toISOString() },
    initialState: null, turnState: null,
  }), null);
});

Deno.test("procedureStateAfterTurn clears a stale opener when procedures are disabled", () => {
  // proceduresOn false means this turn has no procedure runtime. The stale opener is still cleared.
  assertEquals(procedureStateAfterTurn({
    ...base, hadTurn: false, storedState: staleOpener, initialState: null, turnState: null, progressed: false,
  }), null);
});

Deno.test("a stale pending opener expires before the runtime and the stored value is cleared", () => {
  assertEquals(expireIfStale(staleOpener, now), null);
  const ports = { hasStoreCapability: () => false } as ProcedurePorts;
  const turn = createProcedureTurn({
    state: expireIfStale(staleOpener, now),
    config: { lead_capture: { enabled: true, prompts: {}, closing: "" } },
    ports, dryRun: true, now: () => now, runId: "run-1", userId: "user-1", customerPhone: "96500000000",
    leadContext: { platform: "whatsapp", socialAccountId: null, conversationId: "c" },
  });
  assertEquals(turn.start("lead_capture", "model"), true);
  const raw = createProcedureTurn({
    state: staleOpener,
    config: { lead_capture: { enabled: true, prompts: {}, closing: "" } },
    ports, dryRun: true, now: () => now, runId: "run-1", userId: "user-1", customerPhone: "96500000000",
    leadContext: { platform: "whatsapp", socialAccountId: null, conversationId: "c" },
  });
  assertEquals(raw.start("lead_capture", "model"), false);
  assertEquals(procedureStateAfterTurn({
    ...base, hadTurn: true, storedState: staleOpener, initialState: null, turnState: null, progressed: false,
  }), null);
});

Deno.test("clearing a stale opener fails the compare-and-set when the stored state changed", async () => {
  const next = procedureStateAfterTurn({
    ...base, hadTurn: false, storedState: staleOpener, initialState: null, turnState: null,
  });
  assertEquals(next, null);
  const filters: string[] = [];
  let written: unknown;
  const filter = {
    eq(column: string, value: string) { filters.push(`${column}=${value}`); return filter; },
    is(column: string, _value: null) { filters.push(`${column}=is.null`); return filter; },
    select(_columns: "id") { return Promise.resolve({ data: [], error: null }); },
  };
  const db = {
    from: (_table: "ai_threads") => ({
      update(values: { procedure_state: unknown }) { written = values.procedure_state; return filter; },
    }),
  };
  assertEquals(await persistProcedureState(db, "thread-1", staleOpener, next), false);
  assertEquals(written, null);
  assertEquals(filters[0], "id=thread-1");
  assertEquals(filters[1]?.includes("pending_opener"), true);
  assertEquals(filters[1]?.includes(staleOpener.run_id), true);
});

Deno.test("procedureStateAfterTurn: a turn without progress counts as off-script", () => {
  assertEquals((procedureStateAfterTurn(base) as { off_script: number }).off_script, 1);
});

for (const [configured, ranOnLast, iteration, expected] of [
  [3, false, 2, "tools"],
  [3, false, 3, "stop"],
  [1, true, 1, "text_only"],
  [3, true, 3, "text_only"],
  [3, true, 4, "stop"],
] as const) {
  Deno.test(`iterationBudget(${configured}, ${ranOnLast}, ${iteration}) is ${expected}`, () => {
    assertEquals(iterationBudget(configured, ranOnLast, iteration), expected);
  });
}

const woocommerce = { name: "woo", connector_type: "woocommerce" };
const supabaseRows = { name: "db", connector_type: "supabase" };
for (const [label, tools, capability, expected] of [
  ["WooCommerce serves an order lookup", [supabaseRows, woocommerce], "lookup_orders", "woo"],
  ["WooCommerce serves a product search", [woocommerce], "search_products", "woo"],
  ["a generic Supabase table never serves an order lookup", [supabaseRows], "lookup_orders", null],
  ["no connector serves nothing", [], "lookup_orders", null],
] as const) {
  Deno.test(`procedureStoreTool: ${label}`, () => {
    assertEquals(procedureStoreTool([...tools], capability)?.name ?? null, expected);
  });
}
