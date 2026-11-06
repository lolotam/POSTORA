// deno-lint-ignore-file no-import-prefix
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { runAiImageWorker, completionFor, AI_IMAGE_WORKER_LIMITS as L, type AiImageWorkerPorts, type ClaimedImageJob } from "./worker.ts";

const job: ClaimedImageJob = { id: "j1", user_id: "u1", claim_token: "t1", params: { worker: true, prompt: "cat", aspectRatio: "1:1" } };
const model = { provider_code: "google", model_id: "gemini-2.5-flash-image", source: "primary" } as never;

function ports(over: Partial<AiImageWorkerPorts> = {}, queue: ClaimedImageJob[] = [job]) {
  const completed: unknown[] = []; const claims: unknown[][] = [];
  const p: AiImageWorkerPorts = {
    now: () => 0, workerStartedAtMs: 0,
    claim: async (...args) => { claims.push(args); const n = queue.shift(); return n ? [n] : []; },
    loadReferences: async () => [],
    markDispatched: async () => true,
    run: async (_j, onDispatch) => { await onDispatch();
      return { kind: "succeeded", imageUrl: "data:image/png;base64,AA", description: "d", usedModel: model, credentialSource: "platform", attemptErrors: [] }; },
    complete: async (c) => { completed.push(c); return true; },
    log: async () => {},
    ...over,
  };
  return { p, completed, claims };
}

Deno.test("data: result goes to result_data_url; placeholders are overwritten", async () => {
  const { p, completed, claims } = ports();
  assertEquals((await runAiImageWorker(p)).succeeded, 1);
  assertEquals(claims[0], [1, L.lease, L.maxRunningPerUser]);
  assertEquals(completed[0], { jobId: "j1", claimToken: "t1", status: "succeeded", resultUrl: null, resultDataUrl: "data:image/png;base64,AA",
    error: null, provider: "google", modelId: "gemini-2.5-flash-image", credentialSource: "platform",
    params: { description: "d", chain_source: "primary", error_code: null } });
});
Deno.test("https result goes to result_url", () => {
  const c = completionFor(job, { kind: "succeeded", imageUrl: "https://hf.invalid/i.png", description: "", usedModel: model, credentialSource: "byo", attemptErrors: [] });
  assertEquals([c!.resultUrl, c!.resultDataUrl, c!.credentialSource], ["https://hf.invalid/i.png", null, "byo"]);
});
Deno.test("refusal and unknown outcome fail with their codes", () => {
  assertEquals(completionFor(job, { kind: "refused", status: 402, message: "Daily AI generation limit reached", errorCode: "ai_quota_exhausted" })!.params.error_code, "ai_quota_exhausted");
  const u = completionFor(job, { kind: "outcome_unknown", message: "x", usedModel: model, credentialSource: "platform" })!;
  assertEquals([u.status, u.params.error_code, u.provider], ["failed", "ai_outcome_unknown", "google"]);
});
Deno.test("a thrown run (including a missing payload) fails through describeImageFailure", async () => {
  const { p, completed } = ports({ loadReferences: async () => { throw new Error("payload missing for j1"); } });
  await runAiImageWorker(p);
  assertEquals((completed[0] as { status: string }).status, "failed");
});
Deno.test("lease lost or a stale token writes nothing", async () => {
  assertEquals((await runAiImageWorker(ports({ run: async () => ({ kind: "lease_lost" }) }).p)).lost, 1);
  assertEquals((await runAiImageWorker(ports({ complete: async () => false }).p)).lost, 1);
});
Deno.test("onDispatch stamps the claimed token", async () => {
  const seen: string[] = [];
  await runAiImageWorker(ports({ markDispatched: async (id, tok) => { seen.push(`${id}:${tok}`); return true; } }).p);
  assertEquals(seen, ["j1:t1"]);
});
Deno.test("a spent worker claims nothing", async () => {
  const { p, claims } = ports({ workerStartedAtMs: -60_000 });
  assertEquals((await runAiImageWorker(p)).stoppedForLifetime, true);
  assertEquals(claims.length, 0);
});
Deno.test("job deadline leaves the save reserve", async () => {
  let deadline = 0;
  await runAiImageWorker(ports({ run: async (j) => { deadline = j.budget.deadlineMs; return { kind: "lease_lost" }; } }).p);
  assertEquals(deadline, L.workerLifetimeMs - L.saveReserveMs);
});

Deno.test("MEDIUM-2: transient completion failure retries the produced image", async () => {
  let attempts = 0; let runs = 0;
  const { p, completed } = ports();
  const save = p.complete; const generate = p.run;
  p.complete = async (c, signal) => { if (++attempts === 1) throw new Error("database unavailable"); return save(c, signal); };
  p.run = async (...args) => { runs++; return generate(...args); };
  assertEquals((await runAiImageWorker(p)).succeeded, 1);
  assertEquals(completed.length, 1);
  assertEquals([attempts, runs], [2, 1]);
});

Deno.test("MEDIUM-2: persistent completion failure is bounded and the next job still runs", async () => {
  let attempts = 0;
  const { p, completed } = ports({}, [job, { ...job, id: "j2" }]);
  const save = p.complete;
  p.complete = async (c, signal) => { if (c.jobId === "j1") { attempts++; throw new Error("database unavailable"); } return save(c, signal); };
  const summary = await runAiImageWorker(p);
  assertEquals([summary.claimed, summary.succeeded, summary.lost], [2, 1, 1]);
  assertEquals(attempts, 3);
  assertEquals((completed[0] as { jobId: string }).jobId, "j2");
});

Deno.test("MEDIUM-2: completion retries stop at the worker lifetime", async () => {
  let now = 0; let attempts = 0;
  const { p } = ports({ now: () => now, complete: async () => {
    attempts++; now = L.workerLifetimeMs; throw new Error("save reserve spent");
  } });
  assertEquals((await runAiImageWorker(p)).lost, 1);
  assertEquals(attempts, 1);
});
