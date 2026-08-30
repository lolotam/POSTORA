// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  ACTION_RISK_CLASSES,
  ACTION_SCOPES,
  isSendAction,
  limiterRiskClassFor,
  requiredScopeFor,
} from "./router.ts";

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

Deno.test("each action carries its D7 limiter risk class", () => {
  // Decided in spec §D7; get_status is a bounded local read (A),
  // list_templates calls the Meta Graph API (B), send_template spends money
  // and reaches a real customer (C).
  assertEquals(limiterRiskClassFor("get_status"), "A");
  assertEquals(limiterRiskClassFor("list_templates"), "B");
  assertEquals(limiterRiskClassFor("send_template"), "C");
});

Deno.test("unknown actions have no risk class and fail closed upstream", () => {
  assertEquals(limiterRiskClassFor("drop_database"), undefined);
  // Same prototype-chain guard as requiredScopeFor.
  assertEquals(limiterRiskClassFor("toString"), undefined);
  assertEquals(limiterRiskClassFor("constructor"), undefined);
});

Deno.test("every scoped action also carries a risk class, and vice versa", () => {
  // An action present in one map but not the other would be unclassified:
  // checkRateLimit would then fail it closed during every limiter outage —
  // correct, but silent. This makes the drift loud at test time instead,
  // which is the pairing guarantee that keeps the two maps side by side.
  assertEquals(
    Object.keys(ACTION_SCOPES).sort(),
    Object.keys(ACTION_RISK_CLASSES).sort(),
  );
});
