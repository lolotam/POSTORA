import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  type ClaimedRow,
  type ReconcilePorts,
  type ResumeOutcome,
  isWellFormedClaimRow,
  resumePayload,
  runReconcile,
} from "./run.ts";

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
      const id = row.platform_post_id ?? row.candidate_id ?? row.post_id;
      resumed.push(id);
      const outcome = options.outcomes?.[id] ?? { ok: true, status: "processing" };
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


Deno.test("claimed image rows finish before the stale sweep even when one resume is retryable", async () => {
  const events: string[] = [];
  const { fake } = ports({
    claimed: [ROW("image-a"), ROW("image-b")],
    outcomes: { "image-a": { ok: true, status: "completed" }, "image-b": { ok: false, error: "HTTP 503" } },
    sweep: { posts: 0, rows_failed: 0 },
  });
  const resume = fake.resume;
  const sweep = fake.sweep;
  fake.resume = async (row) => {
    events.push(`resume:${row.platform_post_id}`);
    return await resume(row);
  };
  fake.sweep = async () => {
    events.push("sweep");
    return await sweep();
  };
  const summary = await runReconcile(fake);
  assertEquals(events, ["resume:image-a", "resume:image-b", "sweep"]);
  assertEquals(summary.resumed, { completed: 1 });
  assertEquals(summary.resume_errors, 1);
});

Deno.test("reconciler resumes notification_only work items and aggregates outcomes", async () => {
  const notifRow: ClaimedRow = {
    kind: "notification_only",
    post_id: "post-notif-1",
    attempt_started_at: "2026-11-17T12:00:00Z",
    candidate_id: "cand-1",
    claim_id: "claim-1",
  };
  const { fake, logs } = ports({
    claimed: [notifRow],
  });
  fake.resume = (_row) => {
    return Promise.resolve({ ok: true, status: "completed" });
  };
  const summary = await runReconcile(fake);
  assertEquals(summary.claimed, 1);
  assertEquals(summary.resumed, { completed: 1 });
  assertEquals(summary.resume_errors, 0);
  assertEquals(logs.map((l) => l.level), ["info"]);
});

const UPLOAD_ROW: ClaimedRow = {
  kind: "youtube_upload_continuation",
  post_id: "post-upload-1",
  attempt_started_at: "2026-11-18T00:00:00Z",
  candidate_id: "session-1",
  claim_id: "lease-token-1",
};

Deno.test("an upload continuation is dispatched with the token and not the session uri", () => {
  const payload = resumePayload(UPLOAD_ROW);
  assertEquals(payload.post_id, "post-upload-1");
  assertEquals(payload.resume_youtube_upload_session_id, "session-1");
  assertEquals(payload.resume_youtube_upload_lease_token, "lease-token-1");
  assertEquals(payload.attempt_started_at, "2026-11-18T00:00:00Z");
  // The session URI is the credential. It stays in the private session table
  // and must never travel in the dispatch body.
  assert(!("session_uri" in payload));
  assert(!JSON.stringify(payload).includes("upload_id"));
});

Deno.test("a deferred publish is dispatched with its public row", () => {
  assertEquals(resumePayload(ROW("pp-1")), {
    post_id: "post-pp-1",
    resume_platform_post_id: "pp-1",
  });
});

Deno.test("a claimed upload continuation is a well formed row", () => {
  assert(isWellFormedClaimRow(UPLOAD_ROW));
});

Deno.test("a continuation claim must have nonempty string identifiers", () => {
  for (const malformed of [
    { claim_id: "" }, { claim_id: 17 }, { candidate_id: [] },
    { attempt_started_at: {} }, { post_id: " " },
  ]) {
    assert(!isWellFormedClaimRow({ ...UPLOAD_ROW, ...malformed }));
  }
});

Deno.test("a claimed row that carries a public row id it should not have is refused", () => {
  assert(!isWellFormedClaimRow({
    kind: "youtube_upload_continuation",
    post_id: "post-upload-1",
    attempt_started_at: "2026-11-18T00:00:00Z",
    candidate_id: "session-1",
    claim_id: "lease-token-1",
    platform_post_id: "public-row-1",
  }));
});

Deno.test("a row of an unknown kind is refused", () => {
  assert(!isWellFormedClaimRow({ kind: "something_else", post_id: "post-1", platform_post_id: "pp-1" }));
  assert(!isWellFormedClaimRow(null));
});

