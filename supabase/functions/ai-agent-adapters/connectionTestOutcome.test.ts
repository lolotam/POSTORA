import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  persistConnectionTestOutcome,
  type TestOutcomeAdmin,
} from "./connectionTestOutcome.ts";

// The browser never writes the last-test columns; the adapter does, under the
// service role, on its test_connection path. These tests pin the bookkeeping
// contract: which columns, what error text, and — above all — that a failed
// bookkeeping update can never turn a reported probe outcome into a failure.

interface RecordedUpdate {
  table: string;
  values: Record<string, unknown>;
  id: string;
}

function recordingAdmin(
  outcome: { error?: unknown } | Promise<{ error?: unknown }> = { error: null },
): { admin: TestOutcomeAdmin; updates: RecordedUpdate[] } {
  const updates: RecordedUpdate[] = [];
  const admin: TestOutcomeAdmin = {
    from(table: string) {
      return {
        update(values: Record<string, unknown>) {
          return {
            eq(column: string, value: unknown) {
              assertEquals(column, "id");
              updates.push({ table, values, id: String(value) });
              return typeof outcome === "object"
                ? outcome
                : (outcome as unknown as Promise<{ error?: unknown }>);
            },
          };
        },
      };
    },
  };
  return { admin, updates };
}

Deno.test("a successful probe records last_test_ok true and a null error", async () => {
  const { admin, updates } = recordingAdmin();
  await persistConnectionTestOutcome(admin, "tool-1", {
    ok: true,
    vendor: "woocommerce",
    action: "test_connection",
    capabilities: ["search_products", "check_stock", "lookup_orders"],
    read_only: true,
  });

  assertEquals(updates.length, 1);
  assertEquals(updates[0].table, "ai_agent_tools");
  assertEquals(updates[0].id, "tool-1");
  assertEquals(updates[0].values.last_test_ok, true);
  assertEquals(updates[0].values.last_test_error, null);
  assertEquals(typeof updates[0].values.last_test_at, "string");
  assertEquals(Number.isNaN(Date.parse(String(updates[0].values.last_test_at))), false);
});

Deno.test("a failed probe records the code, the safe message, and ok false", async () => {
  const { admin, updates } = recordingAdmin();
  await persistConnectionTestOutcome(admin, "tool-1", {
    ok: false,
    vendor: "woocommerce",
    error: { code: "woocommerce_http_error", message: "WooCommerce rejected the request.", vendor_status: 401 },
  });

  assertEquals(updates[0].values.last_test_ok, false);
  assertEquals(
    updates[0].values.last_test_error,
    "woocommerce_http_error: WooCommerce rejected the request.",
  );
});

Deno.test("a rejected bookkeeping update is non-fatal for a successful probe", async () => {
  const { admin, updates } = recordingAdmin(Promise.reject(new Error("db down")));
  // Must resolve rather than throw: the probe's own outcome is already the
  // answer, and a bookkeeping failure must not repaint it as an error.
  await persistConnectionTestOutcome(admin, "tool-1", {
    ok: true,
    vendor: "supabase",
    action: "test_connection",
    capabilities: ["search_products"],
    read_only: true,
  });
  assertEquals(updates.length, 1);
});

Deno.test("a returned database error object is equally non-fatal", async () => {
  const { admin, updates } = recordingAdmin({ error: { code: "23505" } });
  await persistConnectionTestOutcome(admin, "tool-1", {
    ok: true,
    vendor: "supabase",
    action: "test_connection",
    capabilities: ["search_products"],
    read_only: true,
  });
  assertEquals(updates.length, 1);
});
