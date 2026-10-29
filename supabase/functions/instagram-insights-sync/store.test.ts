/**
 * The owner wire contract: what the accepted SQL may say, and what this
 * adapter is willing to believe.
 *
 * WHAT THIS SUITE COVERS
 *
 *   1. the exact accepted and throttle projections, key for key;
 *   2. the closed key sets: an extra key, a missing key or an inherited key
 *      is not a receipt;
 *   3. an accessor property is refused WITHOUT being invoked;
 *   4. the SQLSTATE vocabulary: P0002, 22023 and 42501 keep their own
 *      meaning, and everything else is indeterminate;
 *   5. the exact RPC arguments, so a target kind, an owner id or a service
 *      mode can never be sent;
 *   6. the status variants: fourteen keys for an actual job, thirteen for the
 *      no-job variant, a scalar pending count and no job id anywhere.
 */
import { assert, assertEquals, assertRejects } from "https://deno.land/std@0.224.0/assert/mod.ts";

import {
  OwnerCollectionStoreError,
  createOwnerCollectionStore,
  type OwnerRpcEnvelope,
  type UserRpcCaller,
} from "./store.ts";

const ACCOUNT_ID = "0f1a0002-0000-4000-8000-000000000012";
const ACCOUNT_ID_UPPER = "0F1A0002-0000-4000-8000-000000000012";
const JOB_ID = "5c1b0003-0000-4000-8000-000000000003";
const CAPTURED_ON = "2026-10-28";
const ACCEPTED_AT = "2026-10-28T07:00:00+00:00";

interface RpcCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

function caller(
  response: unknown,
  calls: RpcCall[] = [],
): UserRpcCaller {
  return async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    return response as OwnerRpcEnvelope;
  };
}

function envelope(data: unknown): OwnerRpcEnvelope {
  return { data, error: null };
}

function acceptedReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accepted: true,
    reason: "enqueued",
    job_id: JOB_ID,
    job_generation: 1,
    status: "queued",
    captured_on: CAPTURED_ON,
    created: true,
    accepted_at: ACCEPTED_AT,
    ...overrides,
  };
}

function throttleReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    accepted: false,
    reason: "throttled",
    retry_after_seconds: 120,
    captured_on: CAPTURED_ON,
    ...overrides,
  };
}

function inventory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    truncated: false,
    partial: false,
    window_covered: true,
    oldest_returned_at: ACCEPTED_AT,
    gap_reason: null,
    pages_fetched: 4,
    ...overrides,
  };
}

function jobStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_kind: "owner",
    target_id: ACCOUNT_ID,
    captured_on: CAPTURED_ON,
    status: "partial",
    job_generation: 3,
    attempts: 2,
    due_at: ACCEPTED_AT,
    next_retry_at: null,
    last_attempt_at: ACCEPTED_AT,
    last_partial_at: ACCEPTED_AT,
    last_success_at: null,
    reason_code: "provider_throttled",
    inventory: inventory(),
    pending_operations: 7,
    ...overrides,
  };
}

function noJobStatus(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    target_kind: "owner",
    target_id: ACCOUNT_ID,
    captured_on: CAPTURED_ON,
    status: "none",
    job_generation: 0,
    attempts: 0,
    due_at: null,
    next_retry_at: null,
    last_attempt_at: null,
    last_partial_at: null,
    last_success_at: null,
    reason_code: null,
    inventory: inventory({
      truncated: false,
      partial: false,
      window_covered: false,
      oldest_returned_at: null,
      gap_reason: null,
      pages_fetched: 0,
    }),
    ...overrides,
  };
}

const signal = new AbortController().signal;

async function enqueue(
  response: unknown,
  mode: "normal" | "force" = "normal",
  calls: RpcCall[] = [],
) {
  const store = createOwnerCollectionStore(caller(response, calls));
  return await store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode, signal });
}

async function status(
  response: unknown,
  capturedOn: string | null = CAPTURED_ON,
  calls: RpcCall[] = [],
) {
  const store = createOwnerCollectionStore(caller(response, calls));
  return await store.readOwnerStatus({ socialAccountId: ACCOUNT_ID, capturedOn, signal });
}

// ---------------------------------------------------------------------------
// The accepted enqueue receipt
// ---------------------------------------------------------------------------

Deno.test("the accepted receipt is returned with its eight keys", async () => {
  const calls: RpcCall[] = [];
  const outcome = await enqueue(envelope(acceptedReceipt()), "normal", calls);

  assertEquals(outcome.kind, "accepted");
  if (outcome.kind !== "accepted") return;
  assertEquals(outcome.projection.accepted, true);
  assertEquals(outcome.projection.reason, "enqueued");
  assertEquals(outcome.projection.job_id, JOB_ID);
  assertEquals(outcome.projection.job_generation, 1);
  assertEquals(outcome.projection.status, "queued");
  assertEquals(outcome.projection.captured_on, CAPTURED_ON);
  assertEquals(outcome.projection.created, true);
  assertEquals(outcome.projection.accepted_at, ACCEPTED_AT);
  assertEquals(Object.keys(outcome.projection).length, 8);
});

Deno.test("the enqueue calls only the accepted owner function with the fixed target kind", async () => {
  const calls: RpcCall[] = [];
  await enqueue(envelope(acceptedReceipt({ reason: "forced", created: false })), "force", calls);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "enqueue_instagram_collection_job");
  assertEquals(calls[0]!.args, {
    p_target_kind: "owner",
    p_target_id: ACCOUNT_ID,
    p_mode: "force",
  });
});

Deno.test("a receipt with an extra key is not a receipt", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ lease_token: "a-lease-must-not-leak" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("a receipt with a missing key is not a receipt", async () => {
  const receipt = acceptedReceipt();
  delete (receipt as Record<string, unknown>).created;

  await assertRejects(
    () => enqueue(envelope(receipt)),
    OwnerCollectionStoreError,
  );
});

Deno.test("a receipt with an inherited key is not a receipt", async () => {
  const receipt = Object.create({ created: true }) as Record<string, unknown>;
  Object.assign(receipt, acceptedReceipt());
  delete (receipt as Record<string, unknown>).created;

  await assertRejects(
    () => enqueue(envelope(receipt)),
    OwnerCollectionStoreError,
  );
});

Deno.test("an accessor property is refused without being invoked", async () => {
  let invoked = false;
  const receipt = acceptedReceipt();
  Object.defineProperty(receipt, "job_id", {
    get() {
      invoked = true;
      return JOB_ID;
    },
    enumerable: true,
    configurable: true,
  });

  await assertRejects(
    () => enqueue(envelope(receipt)),
    OwnerCollectionStoreError,
  );
  assertEquals(invoked, false);
});

Deno.test("the reason and the requested mode must agree", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ reason: "forced" })), "normal"),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ reason: "enqueued" })), "force"),
    OwnerCollectionStoreError,
  );
});

Deno.test("the reason and the created flag must agree with the SQL", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ reason: "enqueued", created: false }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () =>
      enqueue(
        envelope(acceptedReceipt({ reason: "already_enqueued", created: true })),
        "normal",
      ),
    OwnerCollectionStoreError,
  );
});

Deno.test("newly enqueued and forced work is queued", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ status: "completed" }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () =>
      enqueue(
        envelope(acceptedReceipt({ reason: "forced", created: false, status: "completed" })),
        "force",
      ),
    OwnerCollectionStoreError,
  );
});

Deno.test("an existing normal job may truthfully be completed", async () => {
  const outcome = await enqueue(
    envelope(
      acceptedReceipt({
        reason: "already_enqueued",
        created: false,
        status: "completed",
        job_generation: 4,
      }),
    ),
  );

  assertEquals(outcome.kind, "accepted");
  if (outcome.kind !== "accepted") return;
  assertEquals(outcome.projection.status, "completed");
  assertEquals(outcome.projection.created, false);
});

Deno.test("a generation that is not a positive safe integer is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ job_generation: 0 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ job_generation: 1.5 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ job_generation: Number.MAX_SAFE_INTEGER + 2 }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("a job id that is not a UUID is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ job_id: "not-a-uuid" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an impossible capture day is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ captured_on: "2026-02-30" }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ captured_on: "2026-10-28T00:00:00Z" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an infinite timestamp is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(acceptedReceipt({ accepted_at: "infinity" }))),
    OwnerCollectionStoreError,
  );
});

// ---------------------------------------------------------------------------
// The throttle receipt
// ---------------------------------------------------------------------------

Deno.test("the throttle receipt is returned with its four keys", async () => {
  const outcome = await enqueue(envelope(throttleReceipt()));

  assertEquals(outcome.kind, "throttled");
  if (outcome.kind !== "throttled") return;
  assertEquals(outcome.projection.accepted, false);
  assertEquals(outcome.projection.reason, "throttled");
  assertEquals(outcome.projection.retry_after_seconds, 120);
  assertEquals(outcome.projection.captured_on, CAPTURED_ON);
  assertEquals(Object.keys(outcome.projection).length, 4);
});

Deno.test("a retry hint outside the accepted window is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(throttleReceipt({ retry_after_seconds: 901 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(throttleReceipt({ retry_after_seconds: -1 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => enqueue(envelope(throttleReceipt({ retry_after_seconds: 1.5 }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("a zero retry hint is accepted", async () => {
  const outcome = await enqueue(envelope(throttleReceipt({ retry_after_seconds: 0 })));
  assertEquals(outcome.kind, "throttled");
});

Deno.test("a throttle receipt with a fifth key is refused", async () => {
  await assertRejects(
    () => enqueue(envelope(throttleReceipt({ job_id: JOB_ID }))),
    OwnerCollectionStoreError,
  );
});

// ---------------------------------------------------------------------------
// The status projection
// ---------------------------------------------------------------------------

Deno.test("the actual-job projection has fourteen keys and a scalar pending count", async () => {
  const projection = await status(envelope(jobStatus()));

  assertEquals(projection.status, "partial");
  assertEquals(projection.job_generation, 3);
  assertEquals(projection.attempts, 2);
  assertEquals(projection.pending_operations, 7);
  assertEquals(typeof projection.pending_operations, "number");
  assertEquals(Object.keys(projection).length, 14);
  assertEquals("job_id" in projection, false);
});

Deno.test("the no-job projection has thirteen keys and no pending count", async () => {
  const projection = await status(envelope(noJobStatus()));

  assertEquals(projection.status, "none");
  assertEquals(projection.job_generation, 0);
  assertEquals(projection.attempts, 0);
  assertEquals(projection.due_at, null);
  assertEquals(projection.next_retry_at, null);
  assertEquals(projection.last_attempt_at, null);
  assertEquals(projection.last_partial_at, null);
  assertEquals(projection.last_success_at, null);
  assertEquals(projection.reason_code, null);
  assertEquals(projection.inventory.pages_fetched, 0);
  assertEquals("pending_operations" in projection, false);
  assertEquals(Object.keys(projection).length, 13);
  assertEquals("job_id" in projection, false);
});

Deno.test("a no-job projection that carries a pending count is refused", async () => {
  await assertRejects(
    () => status(envelope(noJobStatus({ pending_operations: 0 }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("a no-job projection with a real generation is refused", async () => {
  await assertRejects(
    () => status(envelope(noJobStatus({ job_generation: 1 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(noJobStatus({ attempts: 1 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(noJobStatus({ due_at: ACCEPTED_AT }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(noJobStatus({ reason_code: "provider_throttled" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an actual job always has a positive generation and a due time", async () => {
  await assertRejects(
    () => status(envelope(jobStatus({ job_generation: 0 }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(jobStatus({ due_at: null }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an unknown job status is refused", async () => {
  await assertRejects(
    () => status(envelope(jobStatus({ status: "collecting" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("every accepted SQL status is accepted", async () => {
  for (
    const value of [
      "queued",
      "leased",
      "retry",
      "partial",
      "completed",
      "unavailable",
      "error",
    ]
  ) {
    const projection = await status(envelope(jobStatus({ status: value })));
    assertEquals(projection.status, value);
  }
});

Deno.test("a reason code outside the sanitised grammar is refused", async () => {
  await assertRejects(
    () => status(envelope(jobStatus({ reason_code: "Provider Throttled" }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(jobStatus({ reason_code: "x".repeat(65) }))),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(jobStatus({ reason_code: "" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an inventory with an extra key is refused", async () => {
  await assertRejects(
    () =>
      status(
        envelope(jobStatus({ inventory: inventory({ inventory_cursor: "a-cursor" }) })),
      ),
    OwnerCollectionStoreError,
  );
});

Deno.test("an inventory with a missing key is refused", async () => {
  const broken = inventory();
  delete (broken as Record<string, unknown>).pages_fetched;

  await assertRejects(
    () => status(envelope(jobStatus({ inventory: broken }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("an accessor inventory key is refused without being invoked", async () => {
  let invoked = false;
  const broken = inventory();
  Object.defineProperty(broken, "pages_fetched", {
    get() {
      invoked = true;
      return 4;
    },
    enumerable: true,
    configurable: true,
  });

  await assertRejects(
    () => status(envelope(jobStatus({ inventory: broken }))),
    OwnerCollectionStoreError,
  );
  assertEquals(invoked, false);
});

Deno.test("the returned target must be the requested account", async () => {
  await assertRejects(
    () =>
      status(
        envelope(jobStatus({ target_id: "0f1a9999-0000-4000-8000-000000000099" })),
      ),
    OwnerCollectionStoreError,
  );
  await assertRejects(
    () => status(envelope(jobStatus({ target_kind: "competitor" }))),
    OwnerCollectionStoreError,
  );
});

Deno.test("the returned target id is compared case-insensitively and stored lower case", async () => {
  const projection = await status(envelope(jobStatus({ target_id: ACCOUNT_ID_UPPER })));
  assertEquals(projection.target_id, ACCOUNT_ID);
});

Deno.test("an explicitly requested day must be the day the database answered for", async () => {
  await assertRejects(
    () => status(envelope(jobStatus({ captured_on: "2026-10-27" })), "2026-10-28"),
    OwnerCollectionStoreError,
  );
});

Deno.test("an omitted day accepts the database's own Kuwait day", async () => {
  const projection = await status(envelope(jobStatus()), null);
  assertEquals(projection.captured_on, CAPTURED_ON);
});

Deno.test("the status call sends the requested day and the fixed target kind", async () => {
  const calls: RpcCall[] = [];
  await status(envelope(jobStatus()), CAPTURED_ON, calls);

  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.name, "read_instagram_collection_job_status");
  assertEquals(calls[0]!.args, {
    p_target_kind: "owner",
    p_target_id: ACCOUNT_ID,
    p_capture_day: CAPTURED_ON,
  });
});

Deno.test("an omitted day is sent as null, never as a computed today", async () => {
  const calls: RpcCall[] = [];
  await status(envelope(jobStatus()), null, calls);

  assertEquals(calls[0]!.args.p_capture_day, null);
});

// ---------------------------------------------------------------------------
// The driver envelope and the SQLSTATE vocabulary
// ---------------------------------------------------------------------------

Deno.test("a thrown call is an indeterminate failure, never an empty success", async () => {
  const store = createOwnerCollectionStore(async () => {
    throw new Error("transport failed with a-secret");
  });

  await assertRejects(
    () =>
      store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
    OwnerCollectionStoreError,
  );
});

Deno.test("an envelope without an own error property is refused", async () => {
  await assertRejects(
    () => enqueue({ data: acceptedReceipt() } as unknown as OwnerRpcEnvelope),
    OwnerCollectionStoreError,
  );
});

Deno.test("an inherited error property is refused", async () => {
  const response = Object.create({ data: acceptedReceipt(), error: null }) as OwnerRpcEnvelope;
  await assertRejects(() => enqueue(response), OwnerCollectionStoreError);
});

Deno.test("an undefined error property is refused", async () => {
  await assertRejects(
    () =>
      enqueue({
        data: acceptedReceipt(),
        error: undefined,
      } as unknown as OwnerRpcEnvelope),
    OwnerCollectionStoreError,
  );
});

Deno.test("a SQLSTATE without an own data field stays indeterminate", async () => {
  for (const code of ["P0002", "22023", "42501"]) {
    const store = createOwnerCollectionStore(caller({ error: { code } }));
    const error = await assertRejects(
      () => store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
      OwnerCollectionStoreError,
    );
    assertEquals(error.failure, "indeterminate");
  }
});

Deno.test("an accessor data field does not make a SQLSTATE definitive", async () => {
  let invoked = false;
  const response = {
    error: { code: "P0002" },
    get data() {
      invoked = true;
      return null;
    },
  };
  const store = createOwnerCollectionStore(caller(response));
  const error = await assertRejects(
    () => store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(error.failure, "indeterminate");
  assertEquals(invoked, false);
});

Deno.test("an accessor error property is refused without being invoked", async () => {
  let invoked = false;
  const response = {
    data: acceptedReceipt(),
    get error() {
      invoked = true;
      return null;
    },
  } as unknown as OwnerRpcEnvelope;

  await assertRejects(() => enqueue(response), OwnerCollectionStoreError);
  assertEquals(invoked, false);
});

Deno.test("a missing target refusal keeps its own meaning", async () => {
  const store = createOwnerCollectionStore(
    caller({ data: null, error: { code: "P0002" } }),
  );

  const error = await assertRejects(
    () => store.readOwnerStatus({ socialAccountId: ACCOUNT_ID, capturedOn: null, signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(error.failure, "target_not_found");
});

Deno.test("a request refusal and a role refusal keep their own meaning", async () => {
  const refused = createOwnerCollectionStore(caller({ data: null, error: { code: "22023" } }));
  const requestError = await assertRejects(
    () => refused.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(requestError.failure, "request_refused");

  const roleRefused = createOwnerCollectionStore(caller({ data: null, error: { code: "42501" } }));
  const roleError = await assertRejects(
    () =>
      roleRefused.readOwnerStatus({ socialAccountId: ACCOUNT_ID, capturedOn: null, signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(roleError.failure, "unauthorized");
});

Deno.test("an unknown SQLSTATE is indeterminate, never a success", async () => {
  const store = createOwnerCollectionStore(caller({ data: null, error: { code: "PGRST202" } }));

  const error = await assertRejects(
    () => store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(error.failure, "indeterminate");
});

Deno.test("a failure message never reaches the error text", async () => {
  const store = createOwnerCollectionStore(
    caller({ data: null, error: { code: "P0002", message: "secret sql text" } }),
  );

  const error = await assertRejects(
    () => store.enqueueOwnerJob({ socialAccountId: ACCOUNT_ID, mode: "normal", signal }),
    OwnerCollectionStoreError,
  );
  assertEquals(error.message.includes("secret"), false);
  assertEquals(error.message.includes("P0002"), false);
});
