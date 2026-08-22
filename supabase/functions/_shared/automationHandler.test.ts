import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  COMMENT_AUTOMATION_HANDLERS,
  MESSAGE_AUTOMATION_HANDLERS,
  resolveAutomationHandler,
  resolveCommentAutomationHandler,
} from "./automationHandler.ts";

Deno.test("resolveAutomationHandler defaults to internal and accepts n8n and off", () => {
  assertEquals(resolveAutomationHandler(null), "internal");
  assertEquals(resolveAutomationHandler({}), "internal");
  assertEquals(resolveAutomationHandler({ automation_handler: "n8n" }), "n8n");
  assertEquals(resolveAutomationHandler({ automation_handler: "off" }), "off");
  assertEquals(resolveAutomationHandler({ automation_handler: "unknown" }), "internal");
});

Deno.test("resolveCommentAutomationHandler defaults to off and accepts n8n and internal", () => {
  assertEquals(resolveCommentAutomationHandler(null), "off");
  assertEquals(resolveCommentAutomationHandler({}), "off");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "n8n" }), "n8n");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "internal" }), "internal");
  assertEquals(resolveCommentAutomationHandler({ comment_automation_handler: "bogus" }), "off");
});

Deno.test("handler enums are exported for server-side validation", () => {
  assertEquals([...MESSAGE_AUTOMATION_HANDLERS], ["internal", "n8n", "off"]);
  assertEquals([...COMMENT_AUTOMATION_HANDLERS], ["off", "internal", "n8n"]);
});
