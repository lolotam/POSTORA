import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { type ClaimedRow, type ReconcilePorts, type ResumeOutcome, runReconcile } from "./run.ts";

function ports(options: {
  claimed?: ClaimedRow[];
  outcomes?: Record<string, ResumeOutcome | Error>;
  sweep?: { posts: number; rows_failed: number } | Error;
  claimError?: Error;
} = {}) {
  const logs: { level: string; message: string; metadata: Record<string, unknown> }[] = [];
  const resumed: string[] = [];
  const fake: ReconcilePorts = {
    claim: (limit) => {
      if (options.claimError) return Promise.reject(options.claimError);
      return Promise.resolve((options.claimed ?? []).slice(0, limit));
    },
    resume: (row) => {
      resumed.push(row.platform_post_id);
      const outcome = options.outcomes?.[row.platform_post_id] ?? { ok: true, status: "processing" };
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
    sweep: () => options.sweep instanceof Error ? Promise.reject(options.sweep) : Promise.resolve(options.sweep ?? { posts: 0, rows_failed: 0 }),
    log: (level, message, metadata) => {
      logs.push({ level, message, metadata });
      return Promise.resolve();
    },
  };
  return { fake, logs, resumed };
}

const ROW = (id: string): ClaimedRow => ({ platform_post_id: id, post_id: `post-${id}` });

Deno.test("each claimed row is resumed and the outcomes are counted", async () => {
  const { fake, logs, resumed } = ports({
    claimed: [ROW("a"), ROW("b"), ROW("c")],
    outcomes: { a: { ok: true, status: "completed" }, b: { ok: true, status: "processing" }, c: { ok: true, status: "completed" } },
  });
  const summary = await runReconcile(fake);
  assertEquals(resumed, ["a", "b", "c"]);
  assertEquals(summary.resumed, { completed: 2, processing: 1 });
  assertEquals(summary.resume_errors, 0);
  assertEquals(logs.map((l) => l.level), ["info"]);
});

Deno.test("a failed resume is logged and does not stop the others or the sweep", async () => {
  const { fake, logs } = ports({
    claimed: [ROW("a"), ROW("b")],
    outcomes: { a: new Error("process-post HTTP 503"), b: { ok: true, status: "failed" } },
    sweep: { posts: 1, rows_failed: 2 },
  });
  const summary = await runReconcile(fake);
  assertEquals(summary.resume_errors, 1);
  assertEquals(summary.resumed, { failed: 1 });
  assertEquals(summary.swept_rows, 2);
  assertEquals(logs[0].level, "error");
  assertEquals(logs[0].metadata.failures, [{ platform_post_id: "a", error: "process-post HTTP 503" }]);
});

Deno.test("the sweep runs even when nothing is due, and a sweep error is logged", async () => {
  const { fake, logs } = ports({ sweep: new Error("sweep_stale_processing_posts failed: timeout") });
  const summary = await runReconcile(fake);
  assertEquals(summary.sweep_error, "sweep_stale_processing_posts failed: timeout");
  assertEquals(logs.length, 1);
  assertEquals(logs[0].level, "error");
});

Deno.test("a quiet minute writes no log row", async () => {
  const { fake, logs } = ports();
  await runReconcile(fake);
  assertEquals(logs.length, 0);
});

Deno.test("a failed claim is not reported as nothing due", async () => {
  const { fake, resumed } = ports({ claimError: new Error("claim_deferred_publishes failed: permission denied") });
  await assertRejects(() => runReconcile(fake), Error, "permission denied");
  assertEquals(resumed, []);
});

Deno.test("no more than the limit is resumed per run", async () => {
  const { fake, resumed } = ports({ claimed: [ROW("a"), ROW("b"), ROW("c")] });
  await runReconcile(fake, 2);
  assertEquals(resumed, ["a", "b"]);
});
