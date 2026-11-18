// deno-lint-ignore-file no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import {
  actionProcessingRefusalMessage,
  claimPostForActionProcessing,
  claimPostForProcessing,
} from "./postProcessingClaim.ts";

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
    in: (col: string, val: unknown) => (filters.push(["in", col, val]), chain),
    select: () =>
      Promise.resolve(
        fail
          ? { data: null, error: { message: "connection reset" } }
          : { data: Array.from({ length: rowsMatched }, (_, i) => ({ id: `row-${i}`, processing_started_at: "2026-11-06T11:00:00.000Z" })), error: null },
      ),
  };
  return { client: { from: () => chain }, filters, payload: () => payload };
}

for (const scheduledAt of [undefined, null, "2026-11-06T10:00:00Z"]) {
  Deno.test(`a publish request claim takes precedence over scheduled_at=${scheduledAt}`, async () => {
    const { client, filters } = stub(1);
    const requestedAt = "2026-11-06T11:00:00+00:00";
    const outcome = await claimPostForProcessing(client, "post-1", scheduledAt, requestedAt);
    assertEquals(outcome, { claimed: true, error: null, processingStartedAt: "2026-11-06T11:00:00.000Z" });
    assertEquals(filters, [
      ["eq", "id", "post-1"],
      ["eq", "publish_requested_at", requestedAt],
      ["in", "status", ["pending", "scheduled"]],
    ]);
  });
}

Deno.test("an already claimed publish request does not publish again", async () => {
  const { client } = stub(0);
  assertEquals(await claimPostForProcessing(client, "post-1", undefined, "2026-11-06T11:00:00Z"), {
    claimed: false, error: null, processingStartedAt: null,
  });
});

Deno.test("a scheduler-originated claim is conditioned on the scheduled_at it selected", async () => {
  const { client, filters } = stub(1);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: true, error: null, processingStartedAt: "2026-11-06T11:00:00.000Z" });
  assertEquals(filters, [
    ["eq", "id", "post-1"],
    ["eq", "scheduled_at", "2026-09-03T14:00:00+00:00"],
    ["in", "status", ["pending", "scheduled"]],
  ]);
});

Deno.test("an overlapping scheduler run finds the post already processing and does NOT claim it again", async () => {
  // Two cron ticks selected the same due row. The first claim moved it to
  // `processing`; the status guard makes the second match zero rows, so the
  // post is published once instead of twice.
  const { client } = stub(0);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: false, error: null, processingStartedAt: null });
});

Deno.test("a post unscheduled or rescheduled after selection matches no row and is NOT claimed", async () => {
  // The database is the arbiter: zero rows came back, so the caller must not
  // publish. This is the whole reason the claim exists.
  const { client } = stub(0);
  const outcome = await claimPostForProcessing(client, "post-1", "2026-09-03T14:00:00+00:00");
  assertEquals(outcome, { claimed: false, error: null, processingStartedAt: null });
});

Deno.test("a caller with no expectation keeps the unconditional transition (retries, immediate publishes)", async () => {
  const { client, filters, payload } = stub(1);
  const outcome = await claimPostForProcessing(client, "post-1");
  assertEquals(outcome.claimed, true);
  assertEquals(filters, [["eq", "id", "post-1"]]);
  const written = payload() as { status: string; processing_started_at: string };
  assertEquals(written.status, "processing");
  // The sweeper's clock starts at the claim.
  assertEquals(Math.abs(Date.parse(written.processing_started_at) - Date.now()) < 5_000, true);
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
  assertEquals(outcome, { claimed: false, error: "connection reset", processingStartedAt: null });
});

// ── The claim of an agent action ─────────────────────────────────────────────
//
// The agent route publishes under a lease it took on the post. The lease
// travels with the dispatch, and the database checks it against the durable
// state of the post: a run that lost its lease, or a run whose destinations
// became unsafe after it read its results, publishes nothing.

function actionStub(result: unknown, fail = false) {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client = {
    rpc: (name: string, args: Record<string, unknown>) => {
      calls.push({ name, args });
      return Promise.resolve(
        fail ? { data: null, error: { message: "connection reset" } } : { data: result, error: null },
      );
    },
  };
  return { client, calls };
}

const AGENT_CLAIM = {
  postId: "post-1",
  userId: "user-1",
  actionClaimId: "claim-1",
  accountIds: ["account-1"],
};

Deno.test("the agent claim hands the lease and the targets to the database", async () => {
  const { client, calls } = actionStub({
    status: "claimed",
    processing_started_at: "2026-11-18T16:00:00.123456+00:00",
    account_ids: ["account-1"],
  });
  const outcome = await claimPostForActionProcessing(client, AGENT_CLAIM);
  assertEquals(outcome.claimed, true);
  assertEquals(calls, [{
    name: "claim_post_action_processing",
    args: {
      p_post_id: "post-1",
      p_user_id: "user-1",
      p_action_claim_id: "claim-1",
      p_target_account_ids: ["account-1"],
    },
  }]);
  // The instant is the one the database stored, read back as it was written:
  // rounded to milliseconds it would be a different instant than the row
  // carries, and the fences that compare the two would not match.
  assertEquals(outcome.processingStartedAt, "2026-11-18T16:00:00.123456+00:00");
});

Deno.test("a destination that became unsafe refuses the agent claim", async () => {
  // The marker was written after the route read its results, so the route
  // still believed this destination was safe. The database knows better.
  const { client } = actionStub({
    status: "refused",
    reason: "targets_not_admissible",
    blocked: [{ account_id: "account-1", reason: "publish_outcome_protected" }],
  });
  const outcome = await claimPostForActionProcessing(client, AGENT_CLAIM);
  assertEquals(outcome.claimed, false);
  // A refusal is not an error: the database answered, and the answer was no.
  assertEquals(outcome.error, null);
  assertEquals(outcome.reason, "targets_not_admissible");
  assertEquals(outcome.blocked, [{ account_id: "account-1", reason: "publish_outcome_protected" }]);
  assertEquals(outcome.processingStartedAt, null);
});

Deno.test("a lease that is not live is refused, and the caller can say why", async () => {
  const { client } = actionStub({ status: "refused", reason: "claim_not_live" });
  const outcome = await claimPostForActionProcessing(client, AGENT_CLAIM);
  assertEquals(outcome.claimed, false);
  assertEquals(outcome.reason, "claim_not_live");
  assertEquals(actionProcessingRefusalMessage(outcome).includes("no longer holds the post"), true);
});

Deno.test("the refusal names what happened, and never whose", async () => {
  // The message is written to a log and read by an operator, and it travels to
  // the caller: a customer identifier has no place in it.
  const { client } = actionStub({
    status: "refused",
    reason: "targets_not_admissible",
    blocked: [{ account_id: "account-1", reason: "publish_outcome_protected" }],
  });
  const outcome = await claimPostForActionProcessing(client, AGENT_CLAIM);
  const message = actionProcessingRefusalMessage(outcome);
  assertEquals(message.includes("account-1"), false);
  assertEquals(message.includes("unknown"), true);
});

Deno.test("a database error is an error, never a refusal", async () => {
  // The database could not answer. That is not the same fact as "the answer
  // was no", and the caller must be able to tell them apart.
  const { client } = actionStub(null, true);
  const outcome = await claimPostForActionProcessing(client, AGENT_CLAIM);
  assertEquals(outcome.claimed, false);
  assertEquals(outcome.error, "connection reset");
  assertEquals(outcome.reason, null);
  assertEquals(outcome.blocked, []);
});
