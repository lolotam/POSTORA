import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { parallelizable } from "./logic.ts";

const woocommerce = { connector_type: "woocommerce", read_only_mode: true };
const writable = { connector_type: "custom_rest", read_only_mode: false };

function toolMap(entries: Record<string, { connector_type?: string | null; read_only_mode?: boolean | null }>) {
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
