// supabase/functions/_shared/procedures/config.test.ts
import { assertEquals, assertThrows } from "jsr:@std/assert@1";
import { enabledProcedures, parseProcedureConfig, readProcedureConfig } from "./config.ts";
import { AgentBehaviorError } from "../agentBehaviorError.ts";

const valid = {
  order_status: { enabled: true, prompts: { order_number: "Ask for the order number" }, closing: "" },
  product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "For whom?"] },
};

Deno.test("a valid config round-trips and lists enabled flows in key order", () => {
  const parsed = parseProcedureConfig(valid);
  assertEquals(parsed.order_status?.prompts, { order_number: "Ask for the order number" });
  assertEquals(enabledProcedures(parsed), ["order_status", "product_finder"]);
});

for (const [label, input] of [
  ["unknown procedure key", { weather: { enabled: true, prompts: {}, closing: "" } }],
  ["prompt longer than 300 characters", { lead_capture: { enabled: true, prompts: { name: "x".repeat(301) }, closing: "" } }],
  ["product finder with one question", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] } }],
  ["product finder with four questions", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["a", "b", "c", "d"] } }],
  ["21 booking services", { booking: { enabled: true, prompts: {}, closing: "", services: Array(21).fill("s") } }],
  ["prompt for a field the template lacks", { booking: { enabled: true, prompts: { colour: "x" }, closing: "" } }],
  ["a blank product finder question", { product_finder: { enabled: true, prompts: {}, closing: "", questions: ["Budget?", "  "] } }],
  ["a blank booking service", { booking: { enabled: true, prompts: {}, closing: "", services: ["Haircut", ""] } }],
  ["a store-event flow (Spec B PR 1)", { cod_confirm: { enabled: true, prompts: {}, closing: "" } }],
] as const) {
  Deno.test(`parseProcedureConfig rejects ${label}`, () => {
    assertThrows(() => parseProcedureConfig(input), AgentBehaviorError);
  });
}

Deno.test("readProcedureConfig drops only the invalid flow and never throws", () => {
  const read = readProcedureConfig({
    ...valid,
    product_finder: { enabled: true, prompts: {}, closing: "", questions: ["only"] },
  });
  assertEquals(enabledProcedures(read), ["order_status"]);
  assertEquals(readProcedureConfig("garbage"), {});
  assertEquals(readProcedureConfig({ ...valid, review_request: { enabled: true, prompts: {}, closing: "" } }).review_request, undefined);
  assertEquals(readProcedureConfig(undefined), {});
});

Deno.test("a switched-off product finder with unfinished questions saves without them", () => {
  const parsed = parseProcedureConfig({
    product_finder: { enabled: false, prompts: {}, closing: "", questions: ["", ""] },
  });
  assertEquals(parsed.product_finder, { enabled: false, prompts: {}, closing: "" });
});
