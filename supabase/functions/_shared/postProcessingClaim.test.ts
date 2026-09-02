// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { claimPostForProcessing } from "./postProcessingClaim.ts";

// The claim is a compare-and-set on scheduled_at. What matters is which
// PREDICATE reaches the database, and what the caller is told when it
// matched nothing -- so the stub records the filter chain and returns the
// row count the test chooses.

function stub(rowsMatched: number, fail = false) {
  const filters: [string, string, unknown][] = [];
  let payload: unknown = null;
  const chain: any = {
    update: (values: unknown) => (payload = values, chain),
    eq: (col: string, val: unknown) => (filters.push(["eq", col, val]), chain),
    is: (col: string, val: unknown) => (filters.push(["is", col, val]), chain),
    select: () =>
      Promise.resolve(
        fail
          ? { data: null, error: { message: "connection reset" } }
          : { data: Array.from({ length: rowsMatched }, (_, i) => ({ id: `row-${i}` })), error: null },
      ),
  };
  return { client: { from: () => chain }, filters, payload: () => payload };
}

Deno.test("a scheduler-originated claim is conditioned on the scheduled_at it selected", async () => {
  const { client, filters } = stub(1);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: true, error: null });
  assertEquals(filters, [
    ["eq", "id", "post-1"],
    ["eq", "scheduled_at", "2026-09-03T14:00:00+00:00"],
  ]);
});

Deno.test("a post unscheduled or rescheduled after selection matches no row and is NOT claimed", async () => {
  // The database is the arbiter: zero rows came back, so the caller must not
  // publish. This is the whole reason the claim exists.
  const { client } = stub(0);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: false, error: null });
});

Deno.test("a caller with no expectation keeps the unconditional transition (retries, immediate publishes)", async () => {
  const { client, filters, payload } = stub(1);
  const outcome = await claimPostForProcessing(client, "post-1");
  assertEquals(outcome.claimed, true);
  assertEquals(filters, [["eq", "id", "post-1"]]);
  assertEquals(payload(), { status: "processing" });
});

Deno.test("an explicit null expectation uses IS NULL, because eq.null matches nothing in PostgREST", async () => {
  const { client, filters } = stub(1);
  await claimPostForProcessing(client, "post-1", null);
  assertEquals(filters, [["eq", "id", "post-1"], ["is", "scheduled_at", null]]);
});

Deno.test("a database error is reported as an error, never as 'not claimed'", async () => {
  // Not-claimed means "someone changed the schedule; skip quietly". An error
  // is a different fact and the caller must be able to tell them apart.
  const { client } = stub(0, true);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: false, error: "connection reset" });
});
