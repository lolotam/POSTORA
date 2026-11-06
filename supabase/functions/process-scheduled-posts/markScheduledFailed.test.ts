import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { type FailedMarkQuery, markScheduledPostFailed, type PostsClient } from "./markScheduledFailed.ts";

// The guard is the predicate that reaches the database, so the stub records the filter chain and
// returns the row count the test chooses, as postProcessingClaim.test.ts does for the claim.
function stub(rowsMatched: number, fail = false) {
  const filters: [string, string, unknown][] = [];
  const chain: FailedMarkQuery = {
    eq: (col, val) => (filters.push(["eq", col, val]), chain),
    is: (col, val) => (filters.push(["is", col, val]), chain),
    in: (col, val) => (filters.push(["in", col, val]), chain),
    select: () =>
      Promise.resolve(
        fail
          ? { data: null, error: { message: "connection reset" } }
          : { data: Array.from({ length: rowsMatched }, (_, i) => ({ id: `row-${i}` })), error: null },
      ),
  };
  const client: PostsClient = { from: () => ({ update: () => chain }) };
  return { client, filters };
}

const SCHEDULED_AT = "2026-11-06T10:00:00+00:00";

Deno.test("a post without a publish request is marked failed at the scheduled_at this run selected", async () => {
  const { client, filters } = stub(1);
  assertEquals(await markScheduledPostFailed(client, "post-1", SCHEDULED_AT), { marked: true, error: null });
  assertEquals(filters, [
    ["eq", "id", "post-1"],
    ["eq", "scheduled_at", SCHEDULED_AT],
    ["in", "status", ["pending", "scheduled"]],
    ["is", "publish_requested_at", null],
  ]);
});

// 2026-11-06 review of #390: a fresh request inside the 30 s grace period reached this path and was lost.
Deno.test("a post carrying a queued publish request matches no row and stays queued", async () => {
  const { client } = stub(0);
  assertEquals(await markScheduledPostFailed(client, "post-1", SCHEDULED_AT), { marked: false, error: null });
});

Deno.test("an update error reports the post as not marked", async () => {
  const { client } = stub(0, true);
  assertEquals(await markScheduledPostFailed(client, "post-1", SCHEDULED_AT), {
    marked: false, error: "connection reset",
  });
});
