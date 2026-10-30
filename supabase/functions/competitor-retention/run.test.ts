/**
 * The bounded retention run, with fake ports.
 *
 * WHAT THIS SUITE PROVES
 *
 *   - the published caps are the ones the plan fixes (40s, 50 parents, 500
 *     children, 5s per dependency, 6s of reserve);
 *   - the caps bound the WHOLE invocation, not a slice, and every slice is
 *     asked for the REMAINING budget;
 *   - a low remaining budget starts no new SQL call;
 *   - a call that never answers is stopped by the dependency timeout, and a
 *     call that throws is a failure, not an empty slice;
 *   - an unknown response shape stops the run;
 *   - a disabled, missing or malformed switch stops the run, and a dry run
 *     stays available while the switch is off;
 *   - a dry run asks for a dry-run slice and never reports a deletion;
 *   - the completed slices are still reported when a LATER slice fails;
 *   - every exit writes exactly one audit, and a failing audit changes
 *     nothing.
 */
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  RETENTION_BUDGET_MS,
  RETENTION_CHILD_LIMIT,
  RETENTION_DEPENDENCY_TIMEOUT_MS,
  RETENTION_MIN_REMAINING_MS,
  RETENTION_PARENT_LIMIT,
  runCompetitorRetention,
  type CompetitorRetentionPorts,
  type RetentionAuditEvent,
  type RetentionBatchOutcome,
  type RetentionBatchRequest,
  type RetentionSlice,
} from "./run.ts";

function slice(overrides: Partial<RetentionSlice> = {}): RetentionSlice {
  return {
    switchState: "enabled",
    dryRun: false,
    parentsConsidered: 1,
    parentsDeleted: 1,
    parentsProjected: 1,
    parentsSkippedLiveLease: 0,
    parentsSkippedIneligible: 0,
    childrenCounted: 3,
    childrenDeleted: 3,
    hasMore: false,
    ...overrides,
  };
}

interface FakePorts extends CompetitorRetentionPorts {
  readonly requests: RetentionBatchRequest[];
  readonly audits: RetentionAuditEvent[];
}

function fakePorts(
  respond: (
    request: RetentionBatchRequest,
    index: number,
  ) => RetentionBatchOutcome | Promise<RetentionBatchOutcome>,
): FakePorts {
  const requests: RetentionBatchRequest[] = [];
  const audits: RetentionAuditEvent[] = [];
  return {
    requests,
    audits,
    async runBatch(request) {
      requests.push(request);
      return await respond(request, requests.length - 1);
    },
    async logAudit(event) {
      audits.push(event);
    },
  };
}

Deno.test("the published caps are the ones the plan fixes", () => {
  assertEquals(RETENTION_BUDGET_MS, 40_000);
  assertEquals(RETENTION_PARENT_LIMIT, 50);
  assertEquals(RETENTION_CHILD_LIMIT, 500);
  assertEquals(RETENTION_DEPENDENCY_TIMEOUT_MS, 5_000);
  assertEquals(RETENTION_MIN_REMAINING_MS, 6_000);
});

Deno.test("an empty backlog stops after one slice and reports no deletion", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 0,
      parentsDeleted: 0,
      parentsProjected: 0,
      childrenCounted: 0,
      childrenDeleted: 0,
      hasMore: false,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.slices, 1);
  assertEquals(report.stopReason, "completed");
  assertEquals(report.parentsDeleted, 0);
  assertEquals(report.childrenDeleted, 0);
  assertEquals(report.hasMore, false);
  assertEquals(report.failed, false);
});

Deno.test("the parent cap bounds the whole invocation, not a slice", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 1,
      parentsDeleted: 0,
      parentsProjected: 0,
      childrenCounted: 0,
      childrenDeleted: 0,
      hasMore: true,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.stopReason, "budget_exhausted");
  assertEquals(report.parentsProcessed, RETENTION_PARENT_LIMIT);
  assertEquals(report.slices, RETENTION_PARENT_LIMIT);
  assertEquals(ports.requests.length, RETENTION_PARENT_LIMIT);
});

Deno.test("the child cap bounds the whole invocation, not a slice", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 1,
      parentsDeleted: 1,
      parentsProjected: 1,
      childrenCounted: RETENTION_CHILD_LIMIT,
      childrenDeleted: RETENTION_CHILD_LIMIT,
      hasMore: true,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.stopReason, "budget_exhausted");
  assertEquals(report.childrenDeleted, RETENTION_CHILD_LIMIT);
  assertEquals(ports.requests.length, 1);
});

Deno.test("every slice is asked for the REMAINING budget", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 10,
      parentsDeleted: 10,
      parentsProjected: 10,
      childrenCounted: 20,
      childrenDeleted: 20,
      hasMore: true,
    }),
  }));

  await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(ports.requests[0], { parentLimit: 50, childLimit: 500, dryRun: false });
  assertEquals(ports.requests[1], { parentLimit: 40, childLimit: 480, dryRun: false });
  assertEquals(ports.requests[2], { parentLimit: 30, childLimit: 460, dryRun: false });
});

Deno.test("a request carries no owner, no cutoff and no time", async () => {
  const ports = fakePorts(() => ({ ok: true, slice: slice() }));

  await runCompetitorRetention({ dryRun: false, ports });

  for (const request of ports.requests) {
    assertEquals(Object.keys(request).sort(), ["childLimit", "dryRun", "parentLimit"]);
  }
});

Deno.test("a low remaining budget starts no new SQL call", async () => {
  let clock = 0;
  const ports = fakePorts(() => {
    clock = 35_000;
    return {
      ok: true,
      slice: slice({ parentsConsidered: 1, parentsDeleted: 0, childrenCounted: 0, childrenDeleted: 0, hasMore: true }),
    };
  });

  const report = await runCompetitorRetention({ dryRun: false, ports, clock: () => clock });

  assertEquals(report.slices, 1);
  assertEquals(report.stopReason, "time_budget");
  assertEquals(ports.requests.length, 1);
});

Deno.test("a slice that never answers is stopped by the dependency timeout", async () => {
  const ports = fakePorts(() => new Promise<RetentionBatchOutcome>(() => {}));

  const report = await runCompetitorRetention({
    dryRun: false,
    ports,
    dependencyTimeoutMs: 20,
  });

  assertEquals(report.failed, true);
  assertEquals(report.stopReason, "dependency_timeout");
  assertEquals(report.slices, 1);
});

Deno.test("a slice that throws is a failure, never an empty slice", async () => {
  const ports = fakePorts(() => {
    throw new Error("database is unreachable");
  });

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.failed, true);
  assertEquals(report.stopReason, "rpc_failed");
  assertEquals(report.parentsDeleted, 0);
  assertEquals(report.hasMore, false);
});

Deno.test("an unknown response shape stops the run", async () => {
  const ports = fakePorts(() => ({ unexpected: true } as unknown as RetentionBatchOutcome));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.failed, true);
  assertEquals(report.stopReason, "malformed_response");
});

Deno.test("a malformed response reported by the port stops the run", async () => {
  const ports = fakePorts(() => ({ ok: false, reason: "malformed_response" }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.failed, true);
  assertEquals(report.stopReason, "malformed_response");
});

Deno.test("a disabled switch stops the run and deletes nothing", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      switchState: "disabled",
      parentsConsidered: 0,
      parentsDeleted: 0,
      parentsProjected: 0,
      childrenCounted: 0,
      childrenDeleted: 0,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.stopReason, "switch_disabled");
  assertEquals(report.switchState, "disabled");
  assertEquals(report.parentsDeleted, 0);
  assertEquals(report.childrenDeleted, 0);
  assertEquals(ports.requests.length, 1);
});

Deno.test("a missing and a malformed switch both stop the run", async () => {
  const missing = fakePorts(() => ({
    ok: true,
    slice: slice({ switchState: "missing" }),
  }));
  const missingReport = await runCompetitorRetention({ dryRun: false, ports: missing });
  assertEquals(missingReport.stopReason, "switch_missing");
  assertEquals(missingReport.switchState, "missing");

  const malformed = fakePorts(() => ({
    ok: true,
    slice: slice({ switchState: "malformed" }),
  }));
  const malformedReport = await runCompetitorRetention({ dryRun: false, ports: malformed });
  assertEquals(malformedReport.stopReason, "switch_malformed");
  assertEquals(malformedReport.switchState, "malformed");
});

Deno.test("a dry run asks for a dry-run slice and reports no deletion", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      dryRun: true,
      parentsConsidered: 4,
      parentsDeleted: 0,
      parentsProjected: 4,
      childrenCounted: 40,
      childrenDeleted: 0,
      hasMore: true,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: true, ports });

  assertEquals(ports.requests.length, 1);
  assertEquals(ports.requests[0], { parentLimit: 50, childLimit: 500, dryRun: true });
  assertEquals(report.dryRun, true);
  assertEquals(report.childrenCounted, 40);
  assertEquals(report.childrenDeleted, 0);
  assertEquals(report.parentsDeleted, 0);
  assertEquals(report.parentsProjected, 4);
  assertEquals(report.failed, false);
});

Deno.test("the run reports the parents a slice skipped and the ones it projected", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 4,
      parentsDeleted: 1,
      parentsProjected: 2,
      parentsSkippedLiveLease: 1,
      parentsSkippedIneligible: 1,
      childrenCounted: 6,
      childrenDeleted: 3,
      hasMore: false,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.parentsProcessed, 4);
  assertEquals(report.parentsDeleted, 1);
  assertEquals(report.parentsProjected, 2);
  assertEquals(report.parentsSkippedLiveLease, 1);
  assertEquals(report.parentsSkippedIneligible, 1);
});

Deno.test("a dry run stays available while the switch is off", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      switchState: "disabled",
      dryRun: true,
      parentsConsidered: 3,
      parentsDeleted: 0,
      parentsProjected: 3,
      childrenCounted: 12,
      childrenDeleted: 0,
      hasMore: true,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: true, ports });

  assertEquals(report.switchState, "disabled");
  assertEquals(report.parentsProcessed, 3);
  assertEquals(report.childrenCounted, 12);
  assertEquals(report.childrenDeleted, 0);
  assertEquals(report.failed, false);
  assertEquals(report.stopReason, "completed");
});

Deno.test("the completed slices are still reported when a later slice fails", async () => {
  let call = 0;
  const ports = fakePorts(() => {
    call += 1;
    if (call === 1) {
      return {
        ok: true,
        slice: slice({
          parentsConsidered: 2,
          parentsDeleted: 2,
          parentsProjected: 2,
          childrenCounted: 5,
          childrenDeleted: 5,
          hasMore: true,
        }),
      };
    }
    return { ok: false, reason: "rpc_failed" };
  });

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.failed, true);
  assertEquals(report.stopReason, "rpc_failed");
  assertEquals(report.slices, 2);
  assertEquals(report.parentsDeleted, 2);
  assertEquals(report.childrenDeleted, 5);
});

Deno.test("a slice that considers nothing stops instead of looping on the same lock", async () => {
  const ports = fakePorts(() => ({
    ok: true,
    slice: slice({
      parentsConsidered: 0,
      parentsDeleted: 0,
      parentsProjected: 0,
      childrenCounted: 0,
      childrenDeleted: 0,
      hasMore: true,
    }),
  }));

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.stopReason, "no_progress");
  assertEquals(ports.requests.length, 1);
});

Deno.test("every exit writes exactly one audit with the reason of that exit", async () => {
  const exits: Array<{
    respond: () => RetentionBatchOutcome | Promise<RetentionBatchOutcome>;
    reason: string;
  }> = [
    {
      respond: () => ({
        ok: true,
        slice: slice({ hasMore: false }),
      }),
      reason: "completed",
    },
    {
      respond: () => ({
        ok: true,
        slice: slice({ parentsConsidered: 1, parentsDeleted: 0, childrenCounted: 0, childrenDeleted: 0, hasMore: true }),
      }),
      reason: "budget_exhausted",
    },
    {
      respond: () => ({
        ok: true,
        slice: slice({ switchState: "disabled" }),
      }),
      reason: "switch_disabled",
    },
    {
      respond: () => ({ ok: false, reason: "malformed_response" }),
      reason: "malformed_response",
    },
    {
      respond: () => ({ ok: false, reason: "rpc_failed" }),
      reason: "rpc_failed",
    },
  ];

  for (const exit of exits) {
    const ports = fakePorts(exit.respond);
    await runCompetitorRetention({ dryRun: false, ports });
    assertEquals(ports.audits.length, 1);
    assertEquals(ports.audits[0].reason, exit.reason);
  }
});

Deno.test("the audit carries counts and reasons only, never content", async () => {
  const ports = fakePorts(() => ({ ok: true, slice: slice() }));

  await runCompetitorRetention({ dryRun: false, ports });

  const audit = ports.audits[0];
  assertEquals(
    Object.keys(audit).sort(),
    [
      "children_counted",
      "children_deleted",
      "dry_run",
      "duration_ms",
      "event",
      "has_more",
      "outcome",
      "parents_deleted",
      "parents_processed",
      "reason",
      "slices",
      "switch_state",
    ],
  );
  assertEquals(audit.dry_run, false);
  assertEquals(audit.outcome, "completed");
  assertEquals(audit.switch_state, "enabled");
  assertEquals(typeof audit.duration_ms, "number");
});

Deno.test("a failing audit changes nothing about the run", async () => {
  const ports = fakePorts(() => ({ ok: true, slice: slice() }));
  ports.logAudit = async () => {
    throw new Error("the log table is unavailable");
  };

  const report = await runCompetitorRetention({ dryRun: false, ports });

  assertEquals(report.failed, false);
  assertEquals(report.stopReason, "completed");
  assertEquals(report.parentsDeleted, 1);
});
