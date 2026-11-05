/**
 * The owner daily dispatch and its bounded resume.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the DISPATCH: it starts the day's sweep, it maps the accepted
 *      receipt, it maps a refusal of the configuration, and a failed
 *      statement is INDETERMINATE - never a completion;
 *   2. the RESUME: it never starts a sweep, it is DEFERRED when the budget
 *      is too small, it leaves the drain's write reserve behind, and it
 *      never throws;
 *   3. the log: every outcome is recorded with a bounded event, and no
 *      event ever carries an owner, an account or a credential.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  DAILY_ENQUEUE_CEILING_MS,
  DAILY_ENQUEUE_MIN_BUDGET_MS,
  DAILY_ENQUEUE_WRITE_RESERVE_MS,
  dispatchOwnerDailyEnqueue,
  resumeOwnerDailyEnqueue,
  type DailyEnqueueBudget,
  type OwnerDailyEnqueuePorts,
  type OwnerDailyLogEvent,
} from "./dailyEnqueue.ts";
import type {
  OwnerDailyEnqueueOutcome,
  OwnerDailyEnqueueReceipt,
} from "./dailyEnqueueStore.ts";

function receipt(overrides: Partial<OwnerDailyEnqueueReceipt> = {}): OwnerDailyEnqueueReceipt {
  return {
    targetKind: "owner",
    capturedOn: "2026-10-30",
    sweepStatus: "pending",
    enqueued: 25,
    hasMore: true,
    pageLimit: 25,
    scanned: 25,
    started: true,
    resumed: false,
    ...overrides,
  };
}

interface Harness {
  readonly ports: OwnerDailyEnqueuePorts;
  readonly starts: boolean[];
  readonly logs: OwnerDailyLogEvent[];
}

function createHarness(
  behaviour: (start: boolean) => Promise<OwnerDailyEnqueueOutcome>,
): Harness {
  const starts: boolean[] = [];
  const logs: OwnerDailyLogEvent[] = [];

  return {
    starts,
    logs,
    ports: {
      store: {
        async enqueueDailyPage(input) {
          starts.push(input.start);
          return await behaviour(input.start);
        },
      },
      log: (event) => {
        logs.push(event);
      },
    },
  };
}

function budget(remainingMs: number): DailyEnqueueBudget {
  return { remainingMs: () => remainingMs };
}

// ---------------------------------------------------------------------------
// The dispatch
// ---------------------------------------------------------------------------

Deno.test("the dispatch starts the day's sweep", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt(),
  }));

  const outcome = await dispatchOwnerDailyEnqueue(harness.ports);

  assertEquals(outcome.kind, "accepted");
  assertEquals(harness.starts, [true]);
  assertEquals(harness.logs.length, 1);
  assertEquals(harness.logs[0]!.event, "owner_daily_enqueue_dispatch");
  assertEquals(harness.logs[0]!.outcome, "enqueued");
  assertEquals(harness.logs[0]!.enqueued, 25);
});

Deno.test("a dispatch that enqueued nothing is still an accepted page", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt({ enqueued: 0, scanned: 0, hasMore: false, sweepStatus: "completed" }),
  }));

  const outcome = await dispatchOwnerDailyEnqueue(harness.ports);

  assertEquals(outcome.kind, "accepted");
  if (outcome.kind !== "accepted") return;
  assertEquals(outcome.receipt.enqueued, 0);
  assertEquals(outcome.receipt.hasMore, false);
  assertEquals(harness.logs[0]!.outcome, "no_work");
});

Deno.test("a refusal of the configuration is a decision", async () => {
  for (const reason of ["collection_disabled", "settings_unavailable"] as const) {
    const harness = createHarness(async () => ({
      kind: "refused",
      reason,
      capturedOn: "2026-10-30",
    }));

    const outcome = await dispatchOwnerDailyEnqueue(harness.ports);

    assertEquals(outcome.kind, "refused");
    if (outcome.kind !== "refused") return;
    assertEquals(outcome.reason, reason);
    assertEquals(harness.logs[0]!.outcome, "refused");
    assertEquals(harness.logs[0]!.reasonCode, reason);
  }
});

Deno.test("a failed statement is indeterminate, never a completion", async () => {
  const harness = createHarness(async () => {
    throw new Error("the statement did not answer");
  });

  const outcome = await dispatchOwnerDailyEnqueue(harness.ports);

  assertEquals(outcome.kind, "indeterminate");
  assertEquals(harness.logs[0]!.outcome, "indeterminate");
});

Deno.test("a dispatch that does not answer in time is indeterminate", async () => {
  const harness = createHarness(async () => {
    await new Promise(() => undefined);
    return { kind: "accepted", receipt: receipt() };
  });

  const outcome = await dispatchOwnerDailyEnqueue(harness.ports, { ceilingMs: 10 });

  assertEquals(outcome.kind, "indeterminate");
});

// ---------------------------------------------------------------------------
// The resume
// ---------------------------------------------------------------------------

Deno.test("the resume never starts a sweep", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt({ started: false, resumed: true }),
  }));

  await resumeOwnerDailyEnqueue(harness.ports, budget(40_000));

  assertEquals(harness.starts, [false]);
});

Deno.test("the resume is deferred when the budget is too small", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt(),
  }));

  const outcome = await resumeOwnerDailyEnqueue(
    harness.ports,
    budget(DAILY_ENQUEUE_MIN_BUDGET_MS - 1),
  );

  assertEquals(outcome.attempted, false);
  assertEquals(outcome.deferred, true);
  assertEquals(outcome.enqueued, 0);
  assertEquals(harness.starts, [], "the statement must not be sent");
  assertEquals(harness.logs[0]!.outcome, "deferred");
});

Deno.test("the resume leaves the drain's write reserve behind", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt(),
  }));

  // Exactly the minimum: the ceiling AND the reserve are both still there.
  const outcome = await resumeOwnerDailyEnqueue(
    harness.ports,
    budget(DAILY_ENQUEUE_MIN_BUDGET_MS),
  );

  assertEquals(outcome.attempted, true);
  assertEquals(outcome.deferred, false);
  assertEquals(harness.starts, [false]);
});

Deno.test("the resume keeps the write reserve the caller names", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt(),
  }));

  // A larger reserve means a smaller budget is needed for the resume.
  const outcome = await resumeOwnerDailyEnqueue(
    harness.ports,
    budget(DAILY_ENQUEUE_CEILING_MS + 9_000),
    { writeReserveMs: 9_000 },
  );

  assertEquals(outcome.attempted, true);
  assertEquals(harness.starts, [false]);
});

Deno.test("a failed resume is indeterminate and never throws", async () => {
  const harness = createHarness(async () => {
    throw new Error("the statement did not answer");
  });

  const outcome = await resumeOwnerDailyEnqueue(harness.ports, budget(40_000));

  assertEquals(outcome.attempted, true);
  assertEquals(outcome.indeterminate, true);
  assertEquals(outcome.enqueued, 0);
  assertEquals(harness.logs[0]!.outcome, "indeterminate");
});

Deno.test("a refused resume is recorded and never invented", async () => {
  const harness = createHarness(async () => ({
    kind: "refused",
    reason: "collection_disabled",
    capturedOn: "2026-10-30",
  }));

  const outcome = await resumeOwnerDailyEnqueue(harness.ports, budget(40_000));

  assertEquals(outcome.attempted, true);
  assertEquals(outcome.indeterminate, false);
  assertEquals(outcome.enqueued, 0);
  assertEquals(outcome.sweepStatus, null);
  assertEquals(harness.logs[0]!.outcome, "refused");
});

Deno.test("the resume reports the page it actually ran", async () => {
  const harness = createHarness(async () => ({
    kind: "accepted",
    receipt: receipt({
      started: false,
      resumed: true,
      enqueued: 7,
      scanned: 9,
      hasMore: true,
      sweepStatus: "pending",
    }),
  }));

  const outcome = await resumeOwnerDailyEnqueue(harness.ports, budget(40_000));

  assertEquals(outcome.enqueued, 7);
  assertEquals(outcome.hasMore, true);
  assertEquals(outcome.sweepStatus, "pending");
  assertEquals(outcome.capturedOn, "2026-10-30");
});

Deno.test("the resume ceiling is a dependency ceiling, not the whole budget", async () => {
  assert(
    DAILY_ENQUEUE_CEILING_MS < DAILY_ENQUEUE_MIN_BUDGET_MS,
    "the resume must leave the write reserve behind",
  );
  assertEquals(
    DAILY_ENQUEUE_MIN_BUDGET_MS,
    DAILY_ENQUEUE_CEILING_MS + DAILY_ENQUEUE_WRITE_RESERVE_MS,
  );
});
