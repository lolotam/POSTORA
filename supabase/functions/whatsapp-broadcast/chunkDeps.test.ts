import { assertEquals, assertRejects } from "jsr:@std/assert@1";
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.7.1";
import { createBroadcastChunkPorts } from "./chunkDeps.ts";

interface StubResult {
  data: unknown;
  error: { message: string } | null;
}

/**
 * A stub client whose every query and rpc fails. The chain is thenable, so any await on it
 * resolves to the failure instead of hanging.
 */
function failingClient(result: StubResult = { data: null, error: { message: "boom" } }) {
  const chain: Record<string, unknown> = {};
  for (const method of ["select", "eq", "in", "order", "limit", "not", "is", "update"]) {
    chain[method] = () => chain;
  }
  chain.insert = () => result;
  chain.maybeSingle = () => result;
  chain.single = () => result;
  chain.then = (
    resolve: (value: unknown) => unknown,
    reject: (reason: unknown) => unknown,
  ) => Promise.resolve(result).then(resolve, reject);
  return {
    from: () => chain,
    rpc: () => result,
  } as unknown as SupabaseClient;
}

Deno.test("every chunk adapter throws when the database reports an error", async () => {
  const ports = createBroadcastChunkPorts(failingClient());

  await assertRejects(() => ports.loadBroadcast("b1"));
  await assertRejects(() => ports.loadWhatsAppAccounts("u1"));
  await assertRejects(() => ports.failStaleSends("b1"));
  await assertRejects(() => ports.loadPendingRecipients("b1", 10));
  await assertRejects(() => ports.skipRecipients("b1", ["r1"]));
  await assertRejects(() => ports.optedOutPhones("u1", ["+96550001111"]));
  await assertRejects(() => ports.beginSend("r1"));
  await assertRejects(() => ports.markRecipientSent("r1", "2026-11-07T00:00:00.000Z"));
  await assertRejects(() => ports.markRecipientFailed("r1", "boom"));
  await assertRejects(() => ports.insertOutbound({ user_id: "u1" }));
  await assertRejects(() => ports.refreshTotals("b1", false));
});

Deno.test("a missing broadcast is a confirmed absence, not an error", async () => {
  const ports = createBroadcastChunkPorts(failingClient({ data: null, error: null }));

  assertEquals(await ports.loadBroadcast("b1"), null);
});

Deno.test("the totals adapter reads the row the rpc returned", async () => {
  const ports = createBroadcastChunkPorts(failingClient({
    data: [{ sent: 2, failed: 1, skipped: 3, pending: 4, final_status: "completed" }],
    error: null,
  }));

  assertEquals(await ports.refreshTotals("b1", true), {
    sent: 2,
    failed: 1,
    skipped: 3,
    pending: 4,
    final_status: "completed",
  });
});
