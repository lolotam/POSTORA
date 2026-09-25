import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parallelizable } from "./logic.ts";

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
