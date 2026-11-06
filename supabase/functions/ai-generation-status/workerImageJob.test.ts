// deno-lint-ignore-file no-import-prefix no-explicit-any
import { assertEquals } from "https://deno.land/std@0.208.0/assert/mod.ts";
import { answerWorkerImageJob, isWorkerImageJob, loadOwnedJob, RETRYABLE_READ_BODY } from "./workerImageJob.ts";

const db = (tables: Record<string, { data: unknown; error: unknown }>) => ({
  from: (t: string) => {
    const b: any = { select: () => b, eq: () => b, maybeSingle: () => Promise.resolve(tables[t]) };
    return b;
  },
});
const row = (o: Record<string, unknown> = {}) =>
  ({ id: "j1", modality: "image", status: "queued", params: { worker: true }, result_url: null, error: null, ...o });

Deno.test("B3: a failed job read is an error, not a missing job", async () => {
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: null, error: { message: "timeout" } } }), "j1", "u")).kind, "error");
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: null, error: null } }), "j1", "u")).kind, "missing");
  assertEquals((await loadOwnedJob(db({ ai_generation_jobs: { data: row(), error: null } }), "j1", "u")).kind, "found");
});
Deno.test("B3: a non-string jobId is missing without a query", async () => {
  assertEquals((await loadOwnedJob(db({}), 42, "u")).kind, "missing");
});
Deno.test("B3: a failed payload read is a retryable 503, never 'expired'", async () => {
  const a = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: null, error: { message: "conn reset" } } }), row({ status: "succeeded" }));
  assertEquals(a, { status: 503, body: RETRYABLE_READ_BODY });
});
Deno.test("succeeded: inline data URL, hosted URL, or a real expiry", async () => {
  const inline = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: { result_data_url: "data:image/png;base64,AA" }, error: null } }), row({ status: "succeeded" }));
  assertEquals(inline.body.imageUrl, "data:image/png;base64,AA");
  const hosted = await answerWorkerImageJob(db({}), row({ status: "succeeded", result_url: "https://h/i.png", params: { worker: true, description: "d" } }));
  assertEquals(hosted, { status: 200, body: { success: true, status: "succeeded", imageUrl: "https://h/i.png", url: "https://h/i.png", description: "d" } });
  const gone = await answerWorkerImageJob(db({ ai_image_job_payloads: { data: { result_data_url: null }, error: null } }), row({ status: "succeeded" }));
  assertEquals(gone.body.errorCode, "ai_result_expired");
});
Deno.test("queued/running poll every 3 s; failed carries errorCode", async () => {
  assertEquals((await answerWorkerImageJob(db({}), row())).body, { success: true, status: "queued", pollAfterSeconds: 3 });
  const f = await answerWorkerImageJob(db({}), row({ status: "failed", error: "x", params: { worker: true, error_code: "ai_outcome_unknown" } }));
  assertEquals(f.body, { success: true, status: "failed", error: "x", errorCode: "ai_outcome_unknown" });
});
Deno.test("only worker image rows match", () => {
  assertEquals(isWorkerImageJob(row()), true);
  assertEquals(isWorkerImageJob(row({ modality: "video" })), false);
  assertEquals(isWorkerImageJob(row({ params: { prompt: "sync" } })), false);
  assertEquals(isWorkerImageJob(row({ params: null })), false);
});
