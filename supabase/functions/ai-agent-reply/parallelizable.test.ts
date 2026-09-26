import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  parallelizable,
  readOnlyConnector,
  replyIntentFields,
  sandboxConversationId,
} from "./logic.ts";

// The tool shape index.ts actually passes in: a CustomTool row. auth_strategy
// matters because read_only_mode defaults to true on EVERY row, so the flag
// alone would race tools that are not read-only in practice.
type ParallelizableTool = Parameters<typeof parallelizable>[1] extends
  Map<string, infer T> ? T : never;

const woocommerce = { connector_type: "woocommerce", read_only_mode: true };
const writable = { connector_type: "custom_rest", read_only_mode: false };

function toolMap(entries: Record<string, ParallelizableTool>) {
  return new Map(Object.entries(entries));
}

const call = (name: string) => ({ function: { name } });

Deno.test("a round of read-only connector calls may run in parallel", () => {
  const tools = toolMap({ woo_store: woocommerce, woo_warehouse: { connector_type: "woocommerce" } });
  assertEquals(parallelizable([call("woo_store"), call("woo_warehouse")], tools), true);
});

Deno.test("a single call is not worth parallelising", () => {
  assertEquals(parallelizable([call("woo_store")], toolMap({ woo_store: woocommerce })), false);
});

Deno.test("an agent tool in the round keeps it serial", () => {
  // escalate_to_human is not a custom connector tool; it must never be raced.
  assertEquals(parallelizable([call("woo_store"), call("escalate_to_human")], toolMap({ woo_store: woocommerce })), false);
});

Deno.test("a write-capable connector in the round keeps it serial", () => {
  assertEquals(
    parallelizable([call("woo_store"), call("crm")], toolMap({ woo_store: woocommerce, crm: writable })),
    false,
  );
});

Deno.test("an unknown tool name keeps the round serial", () => {
  assertEquals(parallelizable([call("woo_store"), call("ghost")], toolMap({ woo_store: woocommerce })), false);
});

Deno.test("a legacy custom_rest tool with read_only_mode true stays serial", () => {
  // read_only_mode defaults to true on every row, but a custom_rest webhook
  // (executeCustomTool) can do anything — the flag must not qualify it.
  const tools = toolMap({
    crm: { connector_type: "custom_rest", read_only_mode: true },
    crm2: { connector_type: "custom_rest", read_only_mode: true },
  });
  assertEquals(parallelizable([call("crm"), call("crm2")], tools), false);
});

Deno.test("a composio_oauth tool with read_only_mode true stays serial", () => {
  // Composio tools keep the flag through the ...tool spread but route through
  // Composio, not the read-only adapter; they may carry mutations.
  const tools = toolMap({
    sheets: { connector_type: "google_sheets", read_only_mode: true, auth_strategy: "composio_oauth" },
    sheets2: { connector_type: "google_sheets", read_only_mode: true, auth_strategy: "composio_oauth" },
  });
  assertEquals(parallelizable([call("sheets"), call("sheets2")], tools), false);
});

Deno.test("two woocommerce adapter tools may run in parallel", () => {
  const tools = toolMap({
    woo_store: { connector_type: "woocommerce", read_only_mode: true },
    woo_warehouse: { connector_type: "woocommerce" },
  });
  assertEquals(parallelizable([call("woo_store"), call("woo_warehouse")], tools), true);
});

Deno.test("readOnlyConnector matches the parallelizable predicate and nothing broader", () => {
  assertEquals(readOnlyConnector({ connector_type: "woocommerce" }), true);
  assertEquals(readOnlyConnector({ connector_type: "woocommerce", read_only_mode: false }), true);
  assertEquals(readOnlyConnector({ connector_type: "supabase", read_only_mode: true }), true);
  assertEquals(readOnlyConnector({ connector_type: "supabase", read_only_mode: false }), false);
  assertEquals(readOnlyConnector({ connector_type: "supabase" }), false);
  assertEquals(readOnlyConnector({ connector_type: "custom_rest", read_only_mode: true }), false);
  assertEquals(
    readOnlyConnector({ connector_type: "google_sheets", read_only_mode: true, auth_strategy: "composio_oauth" }),
    false,
  );
});

Deno.test("sandboxConversationId keeps today's thread unless the key is valid", () => {
  assertEquals(sandboxConversationId("whatsapp", "acct-1", undefined), {
    ok: true,
    conversationId: "test_whatsapp_acct-1",
  });
  assertEquals(sandboxConversationId("whatsapp", "acct-1", null), {
    ok: true,
    conversationId: "test_whatsapp_acct-1",
  });
  assertEquals(sandboxConversationId("instagram", "acct-1", "run1-0"), {
    ok: true,
    conversationId: "test_instagram_acct-1_run1-0",
  });
  assertEquals(sandboxConversationId("whatsapp", "acct-1", "has space"), {
    ok: false,
    error: "Invalid test_case_key",
  });
  assertEquals(sandboxConversationId("whatsapp", "acct-1", ""), {
    ok: false,
    error: "Invalid test_case_key",
  });
  assertEquals(sandboxConversationId("whatsapp", "acct-1", "a".repeat(65)), {
    ok: false,
    error: "Invalid test_case_key",
  });
});

Deno.test("replyIntentFields publishes an intent only at triage confidence", () => {
  assertEquals(replyIntentFields(null), { intent: null, intent_status: "off" });
  assertEquals(replyIntentFields({ outcome: null }), { intent: null, intent_status: "uncertain" });
  assertEquals(
    replyIntentFields({ outcome: { answers: { intent: { choice: "pricing", confidence: 0.79 } } } }),
    { intent: null, intent_status: "uncertain" },
  );
  assertEquals(
    replyIntentFields({ outcome: { answers: { intent: null } } }),
    { intent: null, intent_status: "uncertain" },
  );
  assertEquals(
    replyIntentFields({ outcome: { answers: { intent: { choice: "greeting", confidence: 0.8 } } } }),
    { intent: { choice: "greeting", confidence: 0.8 }, intent_status: "classified" },
  );
});
