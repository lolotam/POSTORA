import { assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { WorkerStore, WorkerStoreError } from "./workerStore.ts";

function createValidJobRaw(overrides: Record<string, unknown> = {}) {
  return {
    job_id: "01810001-0000-4000-8000-000000000001",
    user_id: "01810002-0000-4000-8000-000000000002",
    target_id: "01810003-0000-4000-8000-000000000003",
    social_account_id: "01810003-0000-4000-8000-000000000003",
    captured_on: "2026-10-28",
    job_generation: 1,
    claim_token: "01810004-0000-4000-8000-000000000004",
    lease_expires_at: "2026-10-28T12:02:00Z",
    attempts: 0,
    context: {
      viewer_social_account_id: "01810003-0000-4000-8000-000000000003",
      credential_generation: 1,
      login_kind: "direct",
      capability_present: true,
      permission_read_state: "ok",
      granted_scopes: ["instagram_basic", "instagram_manage_insights"],
    },
    checkpoint: {},
    pending_operations: [],
    claimed_at: "2026-10-28T12:00:00Z",
    ...overrides,
  };
}

Deno.test("WorkerStore claims owner jobs and parses envelope correctly", async () => {
  const fakeRpc = (_name: string, _args: Record<string, unknown>) => {
    return Promise.resolve({
      data: [createValidJobRaw()],
      error: null,
    });
  };

  const store = new WorkerStore(fakeRpc);
  const jobs = await store.claimOwnerJobs(10);

  assertEquals(jobs.length, 1);
  assertEquals(jobs[0].jobId, "01810001-0000-4000-8000-000000000001");
  assertEquals(jobs[0].targetId, "01810003-0000-4000-8000-000000000003");
  assertEquals(jobs[0].context.loginKind, "direct");
  assertEquals(jobs[0].context.capabilityPresent, true);
  assertEquals(jobs[0].context.grantedScopes?.length, 2);
});

Deno.test("WorkerStore refuses claimed jobs with missing required properties", async () => {
  const invalid = createValidJobRaw();
  delete (invalid as Record<string, unknown>).claim_token;

  const fakeRpc = () => Promise.resolve({ data: [invalid], error: null });
  const store = new WorkerStore(fakeRpc);

  await assertRejects(() => store.claimOwnerJobs(5), WorkerStoreError, "Missing required property: claim_token");
});

Deno.test("WorkerStore refuses claimed jobs with accessor properties", async () => {
  const invalid = createValidJobRaw();
  Object.defineProperty(invalid, "claim_token", {
    get() {
      return "malicious_token";
    },
    configurable: true,
  });

  const fakeRpc = () => Promise.resolve({ data: [invalid], error: null });
  const store = new WorkerStore(fakeRpc);

  await assertRejects(() => store.claimOwnerJobs(5), WorkerStoreError, "Accessor property forbidden");
});

Deno.test("WorkerStore calls persistSnapshot correctly", async () => {
  let calledWith: Record<string, unknown> | undefined = undefined;
  const fakeRpc = (name: string, args: Record<string, unknown>) => {
    if (name === "persist_instagram_collection_snapshot") {
      calledWith = args;
      return Promise.resolve({ data: { success: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const store = new WorkerStore(fakeRpc);
  await store.persistSnapshot(
    "01810001-0000-4000-8000-000000000001",
    "01810004-0000-4000-8000-000000000004",
    1,
    { kind: "owner_profile_observation", items: [{ metrics: { followers_count: 500 } }] }
  );

  assertEquals((calledWith as Record<string, unknown> | undefined)?.p_job_id, "01810001-0000-4000-8000-000000000001");
  assertEquals((calledWith as Record<string, unknown> | undefined)?.p_claim_token, "01810004-0000-4000-8000-000000000004");
});

Deno.test("WorkerStore calls completeJob correctly", async () => {
  let calledWith: Record<string, unknown> | undefined = undefined;
  const fakeRpc = (name: string, args: Record<string, unknown>) => {
    if (name === "complete_instagram_collection_job") {
      calledWith = args;
      return Promise.resolve({ data: { success: true }, error: null });
    }
    return Promise.resolve({ data: null, error: null });
  };

  const store = new WorkerStore(fakeRpc);
  await store.completeJob(
    "01810001-0000-4000-8000-000000000001",
    "01810004-0000-4000-8000-000000000004",
    1,
    "completed",
    "success"
  );

  assertEquals((calledWith as Record<string, unknown> | undefined)?.p_outcome, "completed");
  assertEquals((calledWith as Record<string, unknown> | undefined)?.p_reason_code, "success");
});

Deno.test("WorkerStore handles RPC failure cleanly with typed error", async () => {
  const fakeRpc = () => {
    return Promise.resolve({
      data: null,
      error: { code: "40001", message: "IG_COLLECTION_CLAIM_STALE: claim is no longer valid" },
    });
  };

  const store = new WorkerStore(fakeRpc);
  const err = await assertRejects(
    () => store.completeJob("01810001-0000-4000-8000-000000000001", "01810004-0000-4000-8000-000000000004", 1, "completed"),
    WorkerStoreError
  );

  assertEquals(err.code, "40001");
});
