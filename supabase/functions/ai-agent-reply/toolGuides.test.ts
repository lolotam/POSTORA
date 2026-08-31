import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { customToolDefinitions, type CustomTool } from "./tools.ts";
import { TOOL_DESCRIPTION_BUDGET } from "../_shared/composeToolDescription.ts";

// What the model is told about a connector before it decides to call one.
//
// PR-2 built the registry guides and the composer; nothing imported them. Until
// this wiring the model received `tool.description` -- whatever the user typed
// in a text box -- and one free-text parameter, with nothing about WHEN to
// reach for the connector or what it cannot do.

const tool = (over: Partial<CustomTool> & { name: string }): CustomTool => ({
  description: "Our Kuwait store, prices in KWD.",
  url: "https://example.test/hook",
  secret: null,
  admin_only: false,
  connector_type: "custom_rest",
  ...over,
});

const describe = (t: CustomTool) =>
  customToolDefinitions([t])[0].function.description;

Deno.test("a typed connector is described with its registry guide", () => {
  const described = describe(tool({ name: "woo_store", connector_type: "woocommerce" }));
  assertEquals(described.includes("stock"), true);
  // The user's own text describes THEIR instance and must survive: replacing it
  // with a generic guide would be a regression for every configured connector.
  assertEquals(described.includes("Our Kuwait store, prices in KWD."), true);
});

Deno.test("the guide precedes the user's own text", () => {
  const described = describe(tool({ name: "woo_store", connector_type: "woocommerce" }));
  assertEquals(described.indexOf("Our Kuwait store") > 0, true);
  assertEquals(described.startsWith("Our Kuwait store"), false);
});

Deno.test("a legacy connector is described exactly as it was before", () => {
  // Every tool in production today is custom_rest, which has no vendor
  // semantics and therefore no guide. This path must be byte-identical -- it is
  // the whole "leave legacy tools intact" requirement, and it is satisfied
  // structurally rather than by a legacy branch.
  const legacy = tool({ name: "n8n_hook" });
  assertEquals(describe(legacy), "Our Kuwait store, prices in KWD.");
});

Deno.test("a connector_type the registry does not know cannot kill the reply", () => {
  // connectorDefinition throws by design. A description is decoration; a throw
  // here would fail a customer's reply over a lookup that only prettifies a
  // prompt, so the guide lookup is deliberately non-throwing.
  const odd = tool({ name: "mystery", connector_type: "not_a_real_type" });
  assertEquals(describe(odd), "Our Kuwait store, prices in KWD.");
});

Deno.test("a missing connector_type behaves like a legacy tool", () => {
  const rows = customToolDefinitions([
    { name: "old", description: "Legacy row.", url: "https://x.test", secret: null, admin_only: false },
  ]);
  assertEquals(rows[0].function.description, "Legacy row.");
});

Deno.test("every composed description stays inside the budget", () => {
  // Tool descriptions are resent on every turn of every conversation and this
  // worker is killed at 60s.
  const wordy = tool({
    name: "woo_store",
    connector_type: "woocommerce",
    description: "x".repeat(4000),
  });
  assertEquals(describe(wordy).length <= TOOL_DESCRIPTION_BUDGET, true);
});
