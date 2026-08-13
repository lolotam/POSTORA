// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { requiredScopeFor, isSendAction } from "./router.ts";

Deno.test("each action maps to its required scope", () => {
  assertEquals(requiredScopeFor("send_template"), "whatsapp:template.send");
  assertEquals(requiredScopeFor("list_templates"), "whatsapp:templates.read");
  assertEquals(requiredScopeFor("get_status"), null);
});

Deno.test("unknown actions have no scope and are rejected upstream", () => {
  assertEquals(requiredScopeFor("drop_database"), undefined);
  // Inherited Object properties must not be mistaken for actions.
  assertEquals(requiredScopeFor("toString"), undefined);
  assertEquals(requiredScopeFor("constructor"), undefined);
});

Deno.test("only send actions require an idempotency key", () => {
  assertEquals(isSendAction("send_template"), true);
  assertEquals(isSendAction("list_templates"), false);
  assertEquals(isSendAction("get_status"), false);
});
