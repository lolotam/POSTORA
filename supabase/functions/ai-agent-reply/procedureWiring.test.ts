// supabase/functions/ai-agent-reply/procedureWiring.test.ts
import { assertEquals } from "jsr:@std/assert@1";
import { iterationBudget, procedureStateAfterTurn, procedureStoreTool } from "./logic.ts";

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
] as const) {
  Deno.test(`procedureStateAfterTurn: ${label}`, () => {
    assertEquals(procedureStateAfterTurn({ ...base, ...overrides } as never), expected);
  });
}

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
