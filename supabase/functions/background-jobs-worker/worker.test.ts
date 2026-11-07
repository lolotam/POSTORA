import { assertEquals } from "jsr:@std/assert@1";
import {
  BACKGROUND_JOBS_LIMITS,
  BACKGROUND_JOBS_MAX_ATTEMPTS,
  runBackgroundJobsWorker,
  type BackgroundJobsWorkerPorts,
  type ClaimedJob,
  type JobOutcome,
} from "./worker.ts";

const START = 1_700_000_000_000;

function job(overrides: Partial<ClaimedJob> = {}): ClaimedJob {
  return {
    id: "job-1",
    user_id: "u1",
    kind: "whatsapp_broadcast_chunk",
    payload: { broadcast_id: "b1" },
    attempts: 1,
    claim_token: "token-1",
    ...overrides,
  };
}

function fakePorts(options: {
  claims: Array<ClaimedJob | null>;
  handler: (job: ClaimedJob, deadlineMs: number) => Promise<JobOutcome>;
  now?: () => number;
  workerStartedAtMs?: number;
  completeAllowed?: (job: ClaimedJob) => boolean;
  continueAllowed?: (job: ClaimedJob) => boolean;
}) {
  const calls = {
    claimed: 0,
    completed: [] as Array<{ id: string; status: string; result: unknown; error: string | null }>,
    continued: [] as string[],
    logs: [] as Array<{ level: string; message: string; metadata: Record<string, unknown> }>,
  };
  const claimQueue = [...options.claims];
  const ports: BackgroundJobsWorkerPorts = {
    now: options.now ?? (() => START),
    workerStartedAtMs: options.workerStartedAtMs ?? START,
    handlers: { whatsapp_broadcast_chunk: options.handler },
    claim: async () => {
      calls.claimed++;
      return claimQueue.shift() ?? null;
    },
    continueJob: async (claimed, _outcome) => {
      calls.continued.push(claimed.id);
      return options.continueAllowed ? options.continueAllowed(claimed) : true;
    },
    complete: async (claimed, status, result, error) => {
      calls.completed.push({ id: claimed.id, status, result, error });
      return options.completeAllowed ? options.completeAllowed(claimed) : true;
    },
    log: async (level, _userId, message, metadata) => {
      calls.logs.push({ level, message, metadata });
    },
  };
  return { ports, calls };
}

Deno.test("done completes the job succeeded", async () => {
  const { ports, calls } = fakePorts({
    claims: [job()],
    handler: async () => ({ kind: "done", result: { sent: 3 } }),
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(summary.claimed, 1);
  assertEquals(summary.done, 1);
  assertEquals(calls.completed, [{ id: "job-1", status: "succeeded", result: { sent: 3 }, error: null }]);
});

Deno.test("continue hands the job back and the same tick claims the next", async () => {
  const { ports, calls } = fakePorts({
    claims: [job({ id: "job-1" }), job({ id: "job-2" })],
    handler: async (claimed) =>
      claimed.id === "job-1"
        ? { kind: "continue", progress: { pending: 2 } }
        : { kind: "done", result: { sent: 2 } },
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.continued, ["job-1"]);
  assertEquals(calls.completed.map((c) => c.id), ["job-2"]);
  assertEquals(summary.continued, 1);
  assertEquals(summary.done, 1);
});

Deno.test("a retryable failure leaves the job running for the lease to expire", async () => {
  const { ports, calls } = fakePorts({
    claims: [job({ attempts: 1 })],
    handler: async () => ({ kind: "failed", error: "opt_out_lookup_failed", retryable: true }),
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.completed, []);
  assertEquals(calls.continued, []);
  assertEquals(summary.failed, 0);
  assertEquals(calls.logs[0].metadata.error, "opt_out_lookup_failed");
});

Deno.test("an exhausted retry completes the job failed", async () => {
  const { ports, calls } = fakePorts({
    claims: [job({ attempts: BACKGROUND_JOBS_MAX_ATTEMPTS })],
    handler: async () => ({ kind: "failed", error: "opt_out_lookup_failed", retryable: true }),
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.completed, [{
    id: "job-1",
    status: "failed",
    result: null,
    error: "opt_out_lookup_failed",
  }]);
  assertEquals(summary.failed, 1);
});

Deno.test("a non-retryable failure completes the job failed", async () => {
  const { ports, calls } = fakePorts({
    claims: [job()],
    handler: async () => ({ kind: "failed", error: "credentials_unavailable", retryable: false }),
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.completed[0].status, "failed");
  assertEquals(calls.completed[0].error, "credentials_unavailable");
  assertEquals(summary.failed, 1);
});

Deno.test("a handler throw is a retryable failure", async () => {
  const { ports, calls } = fakePorts({
    claims: [job()],
    handler: async () => {
      throw new Error("boom");
    },
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.completed, []);
  assertEquals(calls.continued, []);
  assertEquals(summary.failed, 0);
  assertEquals(calls.logs[0].metadata.error, "handler_failed");
});

Deno.test("a lost fence counts lost and the tick continues", async () => {
  const { ports, calls } = fakePorts({
    claims: [job({ id: "job-1" }), job({ id: "job-2" })],
    handler: async () => ({ kind: "done", result: {} }),
    completeAllowed: (claimed) => claimed.id !== "job-1",
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(summary.claimed, 2);
  assertEquals(summary.lost, 1);
  assertEquals(summary.done, 1);
  assertEquals(calls.completed.map((c) => c.id), ["job-1", "job-2"]);
});

Deno.test("no claim when the worker lifetime cannot fit a chunk", async () => {
  const { ports, calls } = fakePorts({
    claims: [job()],
    handler: async () => ({ kind: "done", result: {} }),
    now: () => START + BACKGROUND_JOBS_LIMITS.workerLifetimeMs - BACKGROUND_JOBS_LIMITS.minRemainingToClaimMs + 1,
  });

  const summary = await runBackgroundJobsWorker(ports);

  assertEquals(calls.claimed, 0);
  assertEquals(summary.claimed, 0);
});

Deno.test("the handler deadline never passes the worker lifetime minus the write reserve", async () => {
  let seen = 0;
  const { ports } = fakePorts({
    claims: [job()],
    handler: async (_claimed, deadlineMs) => {
      seen = deadlineMs;
      return { kind: "done", result: {} };
    },
  });

  await runBackgroundJobsWorker(ports);

  const limit = START + BACKGROUND_JOBS_LIMITS.workerLifetimeMs - BACKGROUND_JOBS_LIMITS.writeReserveMs;
  assertEquals(seen <= limit, true);
  assertEquals(seen, START + BACKGROUND_JOBS_LIMITS.chunkBudgetMs);
});

Deno.test("a free-text error never reaches the log", async () => {
  const { ports, calls } = fakePorts({
    claims: [job()],
    handler: async () => ({ kind: "failed", error: "failed for +96550001111", retryable: false }),
  });

  await runBackgroundJobsWorker(ports);

  assertEquals(calls.completed[0].error, "unknown_error");
  assertEquals(calls.logs[0].metadata.error, "unknown_error");
});
