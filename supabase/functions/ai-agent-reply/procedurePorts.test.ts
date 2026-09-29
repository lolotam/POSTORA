import { assertEquals, assertRejects, assertStrictEquals } from "jsr:@std/assert@1";
import { createProcedurePorts, type ProcedurePortsDb, type ProcedurePortsInput } from "./procedurePorts.ts";
import type { CustomTool, ToolContext, ToolResult } from "./tools.ts";

const woo: CustomTool = {
  id: "woo-1",
  name: "store",
  description: "Store",
  url: "https://store.example/hook",
  secret: null,
  admin_only: false,
  connector_type: "woocommerce",
};

const toolContext: ToolContext = {
  admin: {},
  userId: "user-1",
  platform: "whatsapp",
  conversationId: "conv-1",
  customerName: "Customer",
  adminPhoneNumbers: [],
  dryRun: false,
  socialAccountId: "11111111-1111-1111-1111-111111111111",
  requestId: "req-1",
  isAdmin: false,
  retrieveKnowledge: () => Promise.resolve([]),
  sendWhatsAppText: () => Promise.resolve(),
};

function dbThatThrows(message: string): ProcedurePortsDb {
  return {
    from() {
      throw new Error(message);
    },
  } as unknown as ProcedurePortsDb;
}

function portsFor(
  routed: ToolResult,
  store: ToolResult,
  extra: Partial<ProcedurePortsInput> = {},
) {
  const input: ProcedurePortsInput = {
    admin: dbThatThrows("procedure port touched the database"),
    threadId: "thread-1",
    durableState: { current: null },
    userId: "user-1",
    platform: "whatsapp",
    toolContext,
    customTools: [woo],
    startedAt: 0,
    dryRun: false,
    executeRoutedCustomTool: () => Promise.resolve(routed),
    executeProcedureStoreCall: () => Promise.resolve(store),
    ...extra,
  };
  return createProcedurePorts(input);
}

const connectorError = 'Connector "store" failed via woocommerce adapter [vendor_error] (HTTP 500): boom';
const orderSuccess = 'Connector "store" returned: {"changed":true,"status":"processing"}';

Deno.test("a connector error becomes the lookup failure the runtime retries", async () => {
  const ports = portsFor({ output: connectorError }, { output: orderSuccess });
  await assertRejects(
    () => ports.storeLookup("lookup_orders", { order_id: "9" }),
    Error,
    "store_lookup_failed",
  );
});

Deno.test("a successful connector lookup is returned unchanged", async () => {
  const success: ToolResult = { output: 'Connector "store" returned: {"id":9,"status":"processing"}' };
  const ports = portsFor(success, { output: orderSuccess });
  assertStrictEquals(await ports.storeLookup("lookup_orders", { order_id: "9" }), success);
});

for (const marker of ["store_write_denied", "read_only_violation"] as const) {
  Deno.test(`a connector [${marker}] is the denied write the runtime reports`, async () => {
    const denied = { output: `Connector "store" failed via woocommerce adapter [${marker}] (HTTP 403): no` };
    const ports = portsFor({ output: connectorError }, denied);
    assertEquals(
      await ports.updateOrder({ connectorId: "woo-1", orderId: "9", note: "n", expectedStatuses: ["processing"] }),
      { error: "store_write_denied" },
    );
  });
}

Deno.test("a connector error on an order write is the same lookup failure", async () => {
  const ports = portsFor({ output: connectorError }, { output: connectorError });
  await assertRejects(
    () => ports.updateOrder({ connectorId: "woo-1", orderId: "9", note: "n", expectedStatuses: ["processing"] }),
    Error,
    "store_lookup_failed",
  );
});

Deno.test("a successful order write keeps the status the connector returned", async () => {
  const ports = portsFor({ output: connectorError }, { output: orderSuccess });
  assertEquals(
    await ports.updateOrder({ connectorId: "woo-1", orderId: "9", note: "n", expectedStatuses: ["processing"] }),
    { changed: true, status: "processing" },
  );
});

Deno.test("a sandbox procedure failure does not write system_logs", async () => {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  try {
    const ports = portsFor(
      { output: connectorError },
      { output: orderSuccess },
      { dryRun: true, admin: dbThatThrows("sandbox wrote system_logs") },
    );
    await ports.logFailure("Procedure end action failed", { procedure: "order_status", run_id: "run-1" });
    assertEquals(warnings.length, 1);
  } finally {
    console.warn = original;
  }
});

Deno.test("a live procedure failure writes one system_logs warning", async () => {
  const rows: Record<string, unknown>[] = [];
  const admin = {
    from(table: string) {
      if (table !== "system_logs") throw new Error(`unexpected table ${table}`);
      return {
        insert(row: Record<string, unknown>) {
          rows.push(row);
          return Promise.resolve({ error: null });
        },
      };
    },
  } as unknown as ProcedurePortsDb;
  const ports = portsFor(
    { output: connectorError },
    { output: orderSuccess },
    { admin, dryRun: false },
  );
  await ports.logFailure("Procedure end action failed", { procedure: "order_status", run_id: "run-1" });
  assertEquals(rows, [{
    source: "ai-agent-reply",
    category: "ai",
    level: "warn",
    message: "Procedure end action failed",
    user_id: "user-1",
    metadata: { platform: "whatsapp", procedure: "order_status", run_id: "run-1" },
  }]);
});
