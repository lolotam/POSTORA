import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { CollectionWorker } from "./worker.ts";
import { WorkerStore, ClaimedJob } from "./workerStore.ts";
import { InstagramGraphProvider } from "./graphProvider.ts";

function createMockRawJob(id: string, accountId: string) {
  return {
    job_id: id,
    user_id: "user-123",
    target_id: accountId,
    social_account_id: accountId,
    captured_on: "2026-10-28",
    job_generation: 1,
    claim_token: "claim-token-456",
    lease_expires_at: "2026-10-28T12:02:00Z",
    attempts: 0,
    context: {
      login_kind: "direct",
      capability_present: true,
    },
    checkpoint: {},
    pending_operations: [],
    claimed_at: "2026-10-28T12:00:00Z",
  };
}

Deno.test("CollectionWorker successfully drains and completes a job", async () => {
  const job = createMockRawJob("job-01", "account-01");
  const completedJobs: Array<{ id: string; outcome: string; reason?: string }> = [];
  const persistedSnapshots: Array<{ id: string; payload: unknown }> = [];

  const fakeRpc = (name: string, args: Record<string, unknown>) => {
    if (name === "claim_instagram_collection_jobs") {
      return Promise.resolve({ data: [job], error: null });
    }
    if (name === "persist_instagram_collection_snapshot") {
      persistedSnapshots.push({ id: String(args.p_job_id), payload: args.p_payload });
      return Promise.resolve({ data: { success: true }, error: null });
    }
    if (name === "complete_instagram_collection_job") {
      completedJobs.push({
        id: String(args.p_job_id),
        outcome: String(args.p_outcome),
        reason: args.p_reason_code ? String(args.p_reason_code) : undefined,
      });
      return Promise.resolve({ data: { success: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const store = new WorkerStore(fakeRpc);
  const fakeFetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          followers_count: 3200,
          media_count: 42,
          data: [{ id: "m1", media_type: "IMAGE", timestamp: "2026-10-28T12:00:00Z" }],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } }
      )
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  const worker = new CollectionWorker({
    store,
    provider,
    readToken: () => Promise.resolve("valid_token"),
  });

  const result = await worker.runDrain({ batchLimit: 1 });

  assertEquals(result.claimed, 1);
  assertEquals(result.succeeded, 1);
  assertEquals(result.failed, 0);
  assertEquals(result.stoppedEarly, false);
  assertEquals(completedJobs.length, 1);
  assertEquals(completedJobs[0].outcome, "completed");
  assertEquals(completedJobs[0].reason, "success");
  assertEquals(persistedSnapshots.length >= 2, true);
});

Deno.test("CollectionWorker stops early when wall-clock budget is exceeded", async () => {
  const jobs = [createMockRawJob("job-01", "acc-01"), createMockRawJob("job-02", "acc-02")];

  const fakeRpc = (name: string) => {
    if (name === "claim_instagram_collection_jobs") {
      return Promise.resolve({ data: jobs, error: null });
    }
    return Promise.resolve({ data: { success: true }, error: null });
  };

  const store = new WorkerStore(fakeRpc);
  const fakeFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ followers_count: 100, data: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );

  const currentTime = 1000;
  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  let callCount = 0;
  const worker = new CollectionWorker({
    store,
    provider,
    readToken: () => Promise.resolve("valid_token"),
    nowFn: () => {
      callCount++;
      if (callCount === 1) return 1000; // startTime
      if (callCount === 2) return 2000; // job 1 elapsed check
      return 38_000; // job 2 elapsed check (budget exceeded)
    },
  });

  const result = await worker.runDrain({ maxWallClockMs: 40_000, reserveTimeMs: 5_000 });

  assertEquals(result.claimed, 2);
  assertEquals(result.succeeded, 1);
  assertEquals(result.stoppedEarly, true); // Second job was skipped due to budget!
});

Deno.test("CollectionWorker stops drain batch when rate limited", async () => {
  const jobs = [createMockRawJob("job-01", "acc-01"), createMockRawJob("job-02", "acc-02")];
  let recordedThrottle = false;

  const fakeRpc = (name: string) => {
    if (name === "claim_instagram_collection_jobs") {
      return Promise.resolve({ data: jobs, error: null });
    }
    if (name === "record_instagram_provider_throttle") {
      recordedThrottle = true;
      return Promise.resolve({ data: { success: true }, error: null });
    }
    return Promise.resolve({ data: { success: true }, error: null });
  };

  const store = new WorkerStore(fakeRpc);
  const fakeFetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ error: { code: 32, message: "Rate limit" } }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      })
    );

  const provider = new InstagramGraphProvider({ fetchFn: fakeFetch });
  const worker = new CollectionWorker({
    store,
    provider,
    readToken: () => Promise.resolve("valid_token"),
  });

  const result = await worker.runDrain();

  assertEquals(result.claimed, 2);
  assertEquals(result.throttled, 1);
  assertEquals(result.succeeded, 0);
  assertEquals(result.jobs.length, 1); // Second job was aborted due to rate limit!
  assertEquals(recordedThrottle, true);
});
