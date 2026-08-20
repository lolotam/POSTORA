import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { resolveAutomationHandler } from "./automationHandler.ts";

Deno.test("resolveAutomationHandler defaults to internal and accepts only the n8n opt-in", () => {
  assertEquals(resolveAutomationHandler(null), "internal");
  assertEquals(resolveAutomationHandler({}), "internal");
  assertEquals(resolveAutomationHandler({ automation_handler: "n8n" }), "n8n");
  assertEquals(resolveAutomationHandler({ automation_handler: "unknown" }), "internal");
});
